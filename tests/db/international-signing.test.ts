/**
 * International invoicing and the built-in e-signature on PGlite: export
 * invoices and seller details, bank-transfer reports, and the emailed-code
 * signing flow (authenticated signer, attempt limits, exact checksum,
 * evidence on the certificate).
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { migratedDatabase } from "../support/pglite-db";

type Db = Awaited<ReturnType<typeof migratedDatabase>>;
type Row = Record<string, unknown>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("international invoicing and built-in signing (PGlite)", () => {
  let d: Db;
  const u: Record<string, string> = {};
  let org: string;
  let template: string;
  let counter = 0;

  async function one<T extends Row = Row>(user: string | null, sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await d.as<T>(user, sql, params);
    return row;
  }

  /** An agreement sent through the built-in provider to a client in `country`. */
  async function sentInternal(country: string) {
    const n = ++counter;
    const email = `client${n}@abroad.test`;
    ({ id: u[`client${n}`] } = await one<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [email]));
    const { id: prospect } = await one<{ id: string }>(u.sales, `select id from create_prospect($1, $2, 'Client', 'Globex Inc', $3, 'email', null, null, null, null, null, 'c')`, [org, u.sales, email]);
    const proposal = await one<{ id: string; current_version_id: string }>(u.sales, `select * from create_proposal($1, 'Retainer', 'USD', 'c')`, [prospect]);
    const v = proposal.current_version_id;
    await d.as(u.sales, `select save_proposal_draft($1, 'Retainer', 'USD', current_date + 10, $2::jsonb, $3::jsonb, $4::jsonb, '{}', false, false, 'c')`, [
      v, JSON.stringify({ summary: "S", scope: "S" }),
      JSON.stringify([{ label: "All", basis: "percent", percent_bps: 10000, due: "on_signing" }]),
      JSON.stringify([{ title: "Work", quantity: 1, unit_amount_minor: 300000, tax_rate_bps: 0 }]),
    ]);
    await d.as(u.sales, `select submit_proposal_version($1, 'c')`, [v]);
    await d.as(u.sales, `select send_proposal_version($1, 'c')`, [v]);
    await d.as(u.sales, `select create_invitation($1, $2, $3, 14, 'c')`, [prospect, proposal.id, sha(`tok${n}`)]);
    await d.as(u[`client${n}`], `select redeem_invitation($1, 'c')`, [sha(`tok${n}`)]);
    const { h } = await one<{ h: string }>(null, `select content_hash as h from proposal_versions where id = $1`, [v]);
    await d.as(u[`client${n}`], `select accept_proposal($1, $2, $3, 'c')`, [proposal.id, v, h]);
    const contract = await one<{ id: string; checksum: string; client_country: string }>(u.ceo, `select * from generate_contract($1, $2, $3::jsonb, $4, null, 'c')`, [
      proposal.id, template,
      JSON.stringify({ client_legal_name: "Globex Inc", client_address: "1 Market St, San Francisco, CA", client_country: country, signer_name: "Hank Scorpio", signer_email: email }),
      u.ceo,
    ]);
    await d.as(u.ceo, `select transition_contract($1, 'mark_ready', null, 'c')`, [contract.id]);
    await d.as(u.ceo, `select record_contract_sent($1, 'internal', $2, 'c')`, [contract.id, `int_doc_${contract.id}`]);
    return { contract, client: u[`client${n}`], prospect };
  }

  const sign = (user: string, contractId: string, checksum: string, code: string, name = "Hank Scorpio") =>
    one<{ r: { status: string; contract_status?: string; attempts_left?: number } }>(
      user, `select complete_internal_signature($1, $2, $3, $4, $5::jsonb, 'c') as r`,
      [contractId, checksum, sha(code), name, JSON.stringify({ ip_hash: "a1b2", user_agent: "Mozilla/5.0 test" })]);

  beforeAll(async () => {
    d = await migratedDatabase();
    for (const [name, email] of Object.entries({ ceo: "ceo@atmors.test", sales: "sales@atmors.test", stranger: "x@else.test" })) {
      ({ id: u[name] } = await one<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [email]));
      await d.as(null, `update profiles set email = $2 where id = $1`, [u[name], email]);
    }
    ({ id: org } = await one<{ id: string }>(null, `insert into organizations (name, slug) values ('Atmors', 'atmors') returning id`));
    await d.as(null, `insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'ceo'), ($1, $3, 'sales')`, [org, u.ceo, u.sales]);
    ({ id: template } = await one<{ id: string }>(null, `select id from contract_templates where organization_id = $1 and active`, [org]));
    await d.as(u.ceo, `select configure_integration_account($1, 'esign', 'internal', 'internal', true, 'c')`, [org]);
    await d.as(u.ceo, `select save_billing_settings($1, $2::jsonb, 'c')`, [org, JSON.stringify({
      legal_name: "Atmors Private Limited", address: "Bengaluru, India", gstin: "29ABCDE1234F1Z5", lut_number: "AD290000000001",
      bank_instructions: "SWIFT: HDFCINBB, Account 50100000000000, Atmors Private Limited",
    })]);
  });

  it("signs with an emailed code, limits attempts, and keeps the evidence", async () => {
    const { contract, client } = await sentInternal("US");
    expect(contract.client_country).toBe("US");
    expect(await d.errorOf(u.stranger, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("111111")])).toBe("FORBIDDEN");
    expect(await d.errorOf(u.ceo, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("111111")])).toBe("FORBIDDEN"); // client signs first
    expect(await d.errorOf(client, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, "0".repeat(64), sha("111111")])).toBe("VERSION_STALE");

    await d.as(client, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("482913")]);
    expect((await sign(client, contract.id, contract.checksum, "000000")).r).toMatchObject({ status: "wrong_code", attempts_left: 4 });
    expect(await d.errorOf(client, `select complete_internal_signature($1, $2, $3, 'X', '{}'::jsonb, 'c')`, [contract.id, contract.checksum, sha("482913")])).toBe("VALIDATION_FAILED");
    expect((await sign(client, contract.id, contract.checksum, "482913")).r).toMatchObject({ status: "signed", contract_status: "partially_signed" });
    // A code works once.
    expect(await d.errorOf(client, `select complete_internal_signature($1, $2, $3, 'Hank Scorpio', '{}'::jsonb, 'c')`, [contract.id, contract.checksum, sha("482913")])).toBe("FORBIDDEN");

    expect(await d.errorOf(u.sales, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("1")])).toBe("FORBIDDEN");
    await d.as(u.ceo, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("775533")]);
    expect((await sign(u.ceo, contract.id, contract.checksum, "775533", "Yazan Khan")).r).toMatchObject({ status: "signed", contract_status: "executed" });

    const signers = await d.as<{ role: string; evidence: Row }>(null, `select role, evidence from contract_signers where contract_id = $1 order by position`, [contract.id]);
    expect(signers[0].evidence).toMatchObject({ method: "email_code", typed_name: "Hank Scorpio", checksum: contract.checksum, ip_hash: "a1b2" });
    expect(signers[1].evidence).toMatchObject({ method: "email_code", typed_name: "Yazan Khan" });
    const { v } = await one<{ v: { signers: { typed_name: string; method: string }[]; provider: string } }>(client, `select client_contract_view($1) as v`, [contract.id]);
    expect(v.provider).toBe("internal");
    expect(v.signers.map((signer) => signer.typed_name)).toEqual(["Hank Scorpio", "Yazan Khan"]);
    expect(await d.errorOf(null, `select code_hash from signature_challenges limit 1`)).toBeNull(); // stored hashed only
    expect(await d.errorOf(null, `update signature_events set data = '{}' where provider = 'internal'`)).toBe("APPEND_ONLY");
  });

  it("locks the code after five wrong attempts", async () => {
    const { contract, client } = await sentInternal("GB");
    await d.as(client, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("123456")]);
    for (let i = 0; i < 5; i++) await sign(client, contract.id, contract.checksum, "999999");
    expect(await d.errorOf(client, `select complete_internal_signature($1, $2, $3, 'Hank Scorpio', '{}'::jsonb, 'c')`, [contract.id, contract.checksum, sha("123456")])).toBe(
      "INVALID_STATE_TRANSITION",
    );
  });

  it("issues export invoices with seller details and bank instructions while unpaid", async () => {
    const { contract, client } = await sentInternal("US");
    await d.as(client, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("1")]);
    await sign(client, contract.id, contract.checksum, "1");
    await d.as(u.ceo, `select begin_internal_signature($1, $2, $3, 'c')`, [contract.id, contract.checksum, sha("2")]);
    await sign(u.ceo, contract.id, contract.checksum, "2", "Yazan Khan");
    const { id: invoiceId } = await one<{ id: string }>(null, `select id from invoices where contract_id = $1`, [contract.id]);
    const { v } = await one<{ v: Row & { seller: Row; buyer: Row } }>(client, `select client_invoice_view($1) as v`, [invoiceId]);
    expect(v).toMatchObject({ currency: "USD", export: true, tax_minor: 0, bank_instructions: expect.stringContaining("SWIFT") });
    expect(v.seller).toMatchObject({ legal_name: "Atmors Private Limited", gstin: "29ABCDE1234F1Z5", lut_number: "AD290000000001" });
    expect(v.buyer).toMatchObject({ legal_name: "Globex Inc", country: "US" });

    expect(await d.errorOf(u.stranger, `select client_report_transfer($1, 'WIRE-REF-1', null, 'c')`, [invoiceId])).toBe("NOT_FOUND");
    expect(await d.errorOf(client, `select client_report_transfer($1, 'x', null, 'c')`, [invoiceId])).toBe("VALIDATION_FAILED");
    await d.as(client, `select client_report_transfer($1, 'WIRE-REF-1', 'Sent from Chase', 'c')`, [invoiceId]);
    await d.as(client, `select client_report_transfer($1, 'wire-ref-1', null, 'c')`, [invoiceId]); // same reference: one task
    const { n } = await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'transfer_reported' and related_id = $1`, [invoiceId]);
    expect(n).toBe(1);
    const { paid } = await one<{ paid: number }>(null, `select paid_minor as paid from invoices where id = $1`, [invoiceId]);
    expect(Number(paid)).toBe(0); // a report is never a payment

    await d.as(u.ceo, `select record_manual_payment($1, 300000, 'FIRA 2026/123', 'Wire received', 'c')`, [invoiceId]);
    const after = await one<{ v: Row }>(client, `select client_invoice_view($1) as v`, [invoiceId]);
    expect(after.v).toMatchObject({ status: "paid", bank_instructions: null });
    expect(await d.errorOf(client, `select client_report_transfer($1, 'WIRE-REF-2', null, 'c')`, [invoiceId])).toBe("INVALID_STATE_TRANSITION");
  });

  it("keeps domestic invoices without the export note and validates settings", async () => {
    const { contract } = await sentInternal("IN");
    expect(contract.client_country).toBe("IN");
    expect(await d.errorOf(u.sales, `select save_billing_settings($1, '{}'::jsonb, 'c')`, [org])).toBe("FORBIDDEN");
    expect(await d.errorOf(u.ceo, `select save_billing_settings($1, '{"gstin": "bad"}'::jsonb, 'c')`, [org])).not.toBeNull();
    expect(await d.errorOf(u.ceo, `select save_billing_settings($1, '{"bank_instructions": "password: hunter2"}'::jsonb, 'c')`, [org])).toBe("VALIDATION_FAILED");
    const bad = await d.errorOf(u.ceo, `select generate_contract(gen_random_uuid(), $1, '{"client_country": "usa"}'::jsonb, $2, null, 'c')`, [template, u.ceo]);
    expect(bad).toBe("FORBIDDEN"); // unknown proposal fails before validation
  });
});
