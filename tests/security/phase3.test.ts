/**
 * Phase 3 against the hosted dev Supabase project: RLS and grants for
 * booking, contracts and billing, real concurrency for AT-010, sensitive-action
 * authentication for signing and paying (AT-004, AT-024) and the
 * service-role-only provider ingest boundary (AT-014).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateInvitationToken } from "@/modules/crm/invitation-token";

import {
  adminClient,
  anonClient,
  ensureMembership,
  ensureOrganization,
  ensureProspect,
  ensureUser,
  hasSupabaseTestEnv,
  signedInClient,
  type TypedClient,
} from "../support/supabase-fixture";

const EMAIL = {
  ceo: "p3-ceo+clientos@example.com",
  cto: "p3-cto+clientos@example.com",
  sales: "p3-sales+clientos@example.com",
  delivery: "p3-delivery+clientos@example.com",
  clientA: "p3-client-a+clientos@example.com",
  clientB: "p3-client-b+clientos@example.com",
};
type Who = keyof typeof EMAIL;

const CONTENT = { summary: "Grow pipeline", scope: "LinkedIn content", deliverables: [], timeline: "", dependencies: [], assumptions: [], exclusions: [], terms: "" };
const SCHEDULE = [
  { label: "Deposit", basis: "percent", percent_bps: 5000, due: "on_signing" },
  { label: "Balance", basis: "percent", percent_bps: 5000, due: "on_milestone", milestone: "Month 1" },
];
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: "00:00", end: "23:59" }));
const corr = () => randomUUID();
const inDays = (days: number) => new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasSupabaseTestEnv)("Phase 3: booking, contracts and billing", () => {
  const admin = hasSupabaseTestEnv ? adminClient() : (undefined as unknown as TypedClient);
  let c: Record<Who, TypedClient>;
  let users: Record<Who, string>;
  let orgId: string;
  let prospectA: string;
  let prospectB: string;
  let template: string;
  let tokenHashA: string;
  const meetingIds: string[] = [];

  /** Proposal accepted by the prospect's client, then an agreement generated, marked ready and sent. */
  async function sentContract(prospectId: string, client: TypedClient) {
    const { data: proposal, error } = await c.sales.rpc("create_proposal", {
      p_prospect_id: prospectId,
      p_title: `P3 ${randomUUID().slice(0, 8)}`,
      p_currency: "INR",
      p_correlation_id: corr(),
    });
    if (error) throw error;
    const versionId = proposal.current_version_id!;
    for (const [fn, args] of [
      [
        "save_proposal_draft",
        {
          p_version_id: versionId,
          p_title: proposal.title,
          p_currency: "INR",
          p_valid_until: inDays(10),
          p_content: CONTENT,
          p_payment_schedule: SCHEDULE,
          p_line_items: [{ title: "Content", quantity: 1, unit_amount_minor: 100000, tax_rate_bps: 1800 }],
          p_correlation_id: corr(),
        },
      ],
      ["submit_proposal_version", { p_version_id: versionId, p_correlation_id: corr() }],
      ["send_proposal_version", { p_version_id: versionId, p_correlation_id: corr() }],
    ] as const) {
      const result = await c.sales.rpc(fn as "submit_proposal_version", args as never);
      if (result.error) throw result.error;
    }
    const { tokenHash } = generateInvitationToken();
    const invite = await c.sales.rpc("create_invitation", {
      p_prospect_id: prospectId,
      p_proposal_id: proposal.id,
      p_token_hash: tokenHash,
      p_expires_in_days: 14,
      p_correlation_id: corr(),
    });
    if (invite.error) throw invite.error;
    const redeem = await client.rpc("redeem_invitation", { p_token_hash: tokenHash, p_correlation_id: corr() });
    if (redeem.error) throw redeem.error;
    const { data: version } = await c.ceo.from("proposal_versions").select("content_hash").eq("id", versionId).single();
    const accept = await client.rpc("accept_proposal", {
      p_proposal_id: proposal.id,
      p_version_id: versionId,
      p_content_hash: version!.content_hash!,
      p_correlation_id: corr(),
    });
    if (accept.error) throw accept.error;

    const email = prospectId === prospectA ? EMAIL.clientA : EMAIL.clientB;
    const generated = await c.ceo.rpc("generate_contract", {
      p_proposal_id: proposal.id,
      p_template_id: template,
      p_legal: { client_legal_name: "Fixture Client Pvt Ltd", client_address: "1 Test Street, Pune", signer_name: "Fixture Signer", signer_email: email },
      p_countersigner_user_id: users.ceo,
      p_correlation_id: corr(),
    });
    if (generated.error) throw generated.error;
    const contract = generated.data;
    for (const result of [
      await c.ceo.rpc("transition_contract", { p_contract_id: contract.id, p_action: "mark_ready", p_correlation_id: corr() }),
      await c.ceo.rpc("record_contract_sent", {
        p_contract_id: contract.id,
        p_provider: "sandbox",
        p_provider_document_id: `sbx_doc_${contract.id}`,
        p_correlation_id: corr(),
      }),
    ]) {
      if (result.error) throw result.error;
    }
    return { proposalId: proposal.id, contractId: contract.id, checksum: contract.checksum };
  }

  async function signatureEvent(contractId: string, role: "client" | "atmors", email: string) {
    const { data, error } = await admin.rpc("ingest_signature_event", {
      p_provider: "sandbox",
      p_provider_event_id: `p3-${randomUUID()}`,
      p_event_type: "signer.signed",
      p_signature_verified: true,
      p_payload_hash: "a".repeat(64),
      p_provider_document_id: `sbx_doc_${contractId}`,
      p_data: { signer_role: role, signer_email: email },
      p_occurred_at: new Date().toISOString(),
      p_correlation_id: corr(),
    });
    if (error) throw error;
    return data as { status: string };
  }

  beforeAll(async () => {
    users = {} as Record<Who, string>;
    for (const who of Object.keys(EMAIL) as Who[]) users[who] = await ensureUser(admin, EMAIL[who], `P3 ${who}`);
    orgId = await ensureOrganization(admin, "p3-fixture", "Phase 3 Fixture Org");
    await ensureMembership(admin, orgId, users.ceo, "ceo");
    await ensureMembership(admin, orgId, users.cto, "cto_coo");
    await ensureMembership(admin, orgId, users.sales, "sales");
    await ensureMembership(admin, orgId, users.delivery, "delivery");
    prospectA = await ensureProspect(admin, orgId, users.sales, EMAIL.clientA, "Asha P3");
    prospectB = await ensureProspect(admin, orgId, users.sales, EMAIL.clientB, "Bharat P3");

    c = {} as Record<Who, TypedClient>;
    for (const who of Object.keys(EMAIL) as Who[]) c[who] = await signedInClient(EMAIL[who]);

    const { data: templates } = await c.ceo.from("contract_templates").select("id").eq("organization_id", orgId).eq("active", true);
    template = templates![0].id;
    for (const result of [
      await c.cto.rpc("save_booking_host", {
        p_organization_id: orgId,
        p_user_id: users.sales,
        p_purposes: ["commercial"],
        p_timezone: "Asia/Kolkata",
        p_weekly_hours: EVERY_DAY,
        p_slot_minutes: 30,
        p_min_notice_hours: 0,
        p_horizon_days: 14,
        p_active: true,
        p_correlation_id: corr(),
      }),
      await c.ceo.rpc("configure_integration_account", {
        p_organization_id: orgId, p_kind: "esign", p_provider: "sandbox", p_account_id: "sandbox", p_active: true, p_correlation_id: corr(),
      }),
      await c.ceo.rpc("configure_integration_account", {
        p_organization_id: orgId, p_kind: "payments", p_provider: "sandbox", p_account_id: "acc_sandbox", p_active: true, p_correlation_id: corr(),
      }),
    ]) {
      if (result.error) throw result.error;
    }
    ({ tokenHash: tokenHashA } = generateInvitationToken());
    const invite = await c.sales.rpc("create_invitation", {
      p_prospect_id: prospectA,
      p_proposal_id: null as unknown as string,
      p_token_hash: tokenHashA,
      p_expires_in_days: 14,
      p_correlation_id: corr(),
    });
    if (invite.error) throw invite.error;
  });

  afterAll(async () => {
    // Free the fixture host's calendar so repeated runs keep finding slots.
    if (meetingIds.length) await admin.from("meetings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).in("id", meetingIds);
  });

  it("AT-010: concurrent bookings for one host and time confirm exactly once", async () => {
    const from = new Date(Date.now() + 2 * 3_600_000);
    const options = await anonClient().rpc("booking_options_with_token", {
      p_token_hash: tokenHashA,
      p_purpose: "commercial",
      p_from: from.toISOString(),
      p_to: new Date(from.getTime() + 7 * 86_400_000).toISOString(),
    });
    expect(options.error).toBeNull();
    const slots = (options.data as { slots: { start_at: string }[] }).slots;
    // Pick a random open slot so repeated runs do not collide with each other.
    const start = slots[Math.floor(Math.random() * slots.length)].start_at;

    const attempt = () =>
      anonClient().rpc("book_meeting_with_token", {
        p_token_hash: tokenHashA,
        p_purpose: "commercial",
        p_start: start,
        p_timezone: "Asia/Kolkata",
        p_idempotency_key: randomUUID(),
        p_correlation_id: corr(),
      });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    for (const result of results) expect(result.error).toBeNull();
    const outcomes = results.map((result) => result.data as { status: string; meeting?: { id: string }; alternatives?: unknown[] });
    expect(outcomes.filter((outcome) => outcome.status === "booked")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "slot_unavailable")).toHaveLength(2);
    for (const outcome of outcomes) if (outcome.meeting) meetingIds.push(outcome.meeting.id);
    expect(outcomes.find((outcome) => outcome.alternatives)?.alternatives?.length).toBeGreaterThan(0);
  });

  it("AT-011: a callback request creates a task the owner can see and others cannot", async () => {
    const key = randomUUID();
    const result = await anonClient().rpc("request_callback_with_token", {
      p_token_hash: tokenHashA,
      p_purpose: "commercial",
      p_message: "Call me after 5pm",
      p_idempotency_key: key,
      p_correlation_id: corr(),
    });
    expect(result.error).toBeNull();
    const own = await c.sales.from("ops_tasks").select("id, kind").eq("dedupe_key", `callback:${key}`);
    expect(own.data).toHaveLength(1);
    const delivery = await c.delivery.from("ops_tasks").select("id").eq("dedupe_key", `callback:${key}`);
    expect(delivery.data).toHaveLength(0);
    const client = await c.clientA.from("ops_tasks").select("id");
    expect(client.data ?? []).toHaveLength(0);
  });

  it("keeps booking writes behind RPCs and staff calendars private", async () => {
    const insert = await c.clientA.from("meetings").insert({
      organization_id: orgId,
      prospect_id: prospectA,
      purpose: "commercial",
      host_user_id: users.sales,
      start_at: new Date().toISOString(),
      end_at: new Date(Date.now() + 1_800_000).toISOString(),
      timezone: "UTC",
      idempotency_key: randomUUID(),
      booked_by_type: "client",
    });
    expect(insert.error).not.toBeNull();
    const anonHosts = await anonClient().from("booking_hosts").select("*");
    expect(anonHosts.data ?? []).toHaveLength(0);
    const clientMeetings = await c.clientA.from("meetings").select("id");
    expect(clientMeetings.data ?? []).toHaveLength(0); // clients read meetings only through client_meetings()
    const routing = await c.sales.rpc("save_booking_host", {
      p_organization_id: orgId,
      p_user_id: users.sales,
      p_purposes: ["commercial", "onboarding"],
      p_timezone: "Asia/Kolkata",
      p_weekly_hours: EVERY_DAY,
      p_correlation_id: corr(),
    });
    expect(routing.error?.message).toBe("FORBIDDEN");
  });

  it("AT-004/AT-024: only the named, signed-in signer can sign; other clients see nothing", async () => {
    const a = await sentContract(prospectA, c.clientA);
    const asOther = await c.clientB.rpc("client_contract_view", { p_contract_id: a.contractId });
    expect(asOther.error?.message).toBe("NOT_FOUND");
    const otherSign = await c.clientB.rpc("client_prepare_signature", { p_contract_id: a.contractId, p_checksum: a.checksum, p_correlation_id: corr() });
    expect(otherSign.error?.message).toBe("NOT_FOUND");
    const anonSign = await anonClient().rpc("client_prepare_signature", { p_contract_id: a.contractId, p_checksum: a.checksum, p_correlation_id: corr() });
    expect(anonSign.error).not.toBeNull();
    const staffSign = await c.sales.rpc("client_prepare_signature", { p_contract_id: a.contractId, p_checksum: a.checksum, p_correlation_id: corr() });
    expect(staffSign.error?.message).toBe("NOT_FOUND");

    const view = await c.clientA.rpc("client_contract_view", { p_contract_id: a.contractId });
    expect(view.error).toBeNull();
    expect(view.data).toMatchObject({ can_sign: true });
    expect(JSON.stringify(view.data)).not.toContain(users.ceo); // no internal IDs or staff emails
    expect(JSON.stringify(view.data)).not.toContain(EMAIL.ceo);
    const sign = await c.clientA.rpc("client_prepare_signature", { p_contract_id: a.contractId, p_checksum: a.checksum, p_correlation_id: corr() });
    expect(sign.error).toBeNull();
  });

  it("restricts contract, invoice and provider tables to the right roles", async () => {
    const a = await sentContract(prospectA, c.clientA);
    await signatureEvent(a.contractId, "client", EMAIL.clientA);
    await signatureEvent(a.contractId, "atmors", EMAIL.ceo);

    const contractsFor = async (who: Who) => (await c[who].from("contracts").select("id").eq("id", a.contractId)).data ?? [];
    expect(await contractsFor("ceo")).toHaveLength(1);
    for (const who of ["cto", "sales", "delivery", "clientA"] as Who[]) expect(await contractsFor(who)).toHaveLength(0);

    const invoicesFor = async (who: Who) => (await c[who].from("invoices").select("id").eq("contract_id", a.contractId)).data ?? [];
    expect(await invoicesFor("ceo")).toHaveLength(1); // deposit issued on execution
    for (const who of ["cto", "sales", "delivery", "clientA", "clientB"] as Who[]) expect(await invoicesFor(who)).toHaveLength(0);

    for (const table of ["payments", "payment_events", "payment_adjustments", "contract_signers", "contract_templates", "invoice_counters"] as const) {
      const rows = await c.delivery.from(table).select("*").limit(1);
      expect(rows.data ?? []).toHaveLength(0);
    }
    // Operations sees activation status, not the terms.
    const evaluations = await c.cto.from("activation_evaluations").select("eligible, blocking_reasons").eq("contract_id", a.contractId);
    expect(evaluations.data?.length).toBeGreaterThan(0);
    expect(evaluations.data![0]).toMatchObject({ eligible: false, blocking_reasons: ["payment_item_unpaid:0"] });

    const clientInvoices = await c.clientA.rpc("client_invoices");
    const invoiceId = (clientInvoices.data as { id: string }[]).find(Boolean)!.id;
    expect((await c.clientB.rpc("client_invoice_view", { p_invoice_id: invoiceId })).error?.message).toBe("NOT_FOUND");
    const otherPay = await c.clientB.rpc("client_start_payment", {
      p_invoice_id: invoiceId,
      p_provider: "sandbox",
      p_idempotency_key: randomUUID(),
      p_correlation_id: corr(),
    });
    expect(otherPay.error?.message).toBe("NOT_FOUND");
    const anonPay = await anonClient().rpc("client_start_payment", {
      p_invoice_id: invoiceId,
      p_provider: "sandbox",
      p_idempotency_key: randomUUID(),
      p_correlation_id: corr(),
    });
    expect(anonPay.error).not.toBeNull();
  });

  it("AT-014: provider ingest and order attachment are service-role only", async () => {
    const forged = {
      p_provider: "sandbox",
      p_provider_event_id: `forged-${randomUUID()}`,
      p_event_type: "payment.succeeded",
      p_signature_verified: true,
      p_payload_hash: "b".repeat(64),
      p_data: { amount_minor: 1 },
      p_correlation_id: corr(),
    };
    for (const client of [anonClient(), c.clientA, c.ceo]) {
      const result = await client.rpc("ingest_payment_event", forged);
      expect(result.error).not.toBeNull();
      const order = await client.rpc("attach_payment_order", { p_payment_id: randomUUID(), p_provider_order_id: "x" });
      expect(order.error).not.toBeNull();
    }
    // Even the service role cannot rewrite recorded evidence.
    const recorded = await admin.rpc("ingest_payment_event", { ...forged, p_signature_verified: false });
    expect(recorded.data).toMatchObject({ status: "quarantined", error_code: "SIGNATURE_INVALID" });
    const tamper = await admin.from("payment_events").update({ processing_status: "processed" }).eq("id", (recorded.data as { event_id: string }).event_id);
    expect(tamper.error).not.toBeNull();
  });

  it("AT-015/016 on real Postgres: duplicates are ignored and mismatches quarantined", async () => {
    const a = await sentContract(prospectA, c.clientA);
    await signatureEvent(a.contractId, "client", EMAIL.clientA);
    await signatureEvent(a.contractId, "atmors", EMAIL.ceo);
    const { data: invoice } = await c.ceo.from("invoices").select("id, balance_minor").eq("contract_id", a.contractId).single();
    const started = await c.clientA.rpc("client_start_payment", {
      p_invoice_id: invoice!.id,
      p_provider: "sandbox",
      p_idempotency_key: randomUUID(),
      p_correlation_id: corr(),
    });
    expect(started.error).toBeNull();
    const paymentId = (started.data as { payment_id: string }).payment_id;
    const order = `sbx_order_${paymentId}`;
    expect((await admin.rpc("attach_payment_order", { p_payment_id: paymentId, p_provider_order_id: order })).error).toBeNull();

    const event = (id: string, data: Record<string, unknown>) =>
      admin.rpc("ingest_payment_event", {
        p_provider: "sandbox",
        p_provider_event_id: id,
        p_event_type: "payment.succeeded",
        p_signature_verified: true,
        p_payload_hash: "c".repeat(64),
        p_data: { account_id: "acc_sandbox", provider_order_id: order, provider_payment_id: `sbx_pay_${paymentId}`, currency: "INR", ...data },
        p_correlation_id: corr(),
      });
    const mismatch = await event(`p3-mm-${paymentId}`, { amount_minor: invoice!.balance_minor - 1 });
    expect(mismatch.data).toMatchObject({ status: "quarantined", error_code: "PAYMENT_MISMATCH" });
    const ok = await event(`p3-ok-${paymentId}`, { amount_minor: invoice!.balance_minor });
    expect(ok.data).toMatchObject({ status: "processed" });
    const dup = await event(`p3-ok-${paymentId}`, { amount_minor: invoice!.balance_minor });
    expect(dup.data).toMatchObject({ status: "duplicate" });

    const { data: after } = await c.ceo.from("invoices").select("status, paid_minor").eq("id", invoice!.id).single();
    expect(after).toMatchObject({ status: "paid", paid_minor: invoice!.balance_minor });
    const status = await c.clientA.rpc("client_payment_status", { p_payment_id: paymentId });
    expect(status.data).toMatchObject({ status: "succeeded", invoice_status: "paid" });
  });

  it("denies staff actions outside each role's authority", async () => {
    const a = await sentContract(prospectB, c.clientB);
    const checks: [Who, string, Record<string, unknown>][] = [
      ["delivery", "transition_contract", { p_contract_id: a.contractId, p_action: "void", p_reason: "not mine", p_correlation_id: corr() }],
      ["sales", "transition_contract", { p_contract_id: a.contractId, p_action: "void", p_reason: "not mine", p_correlation_id: corr() }],
      ["cto", "configure_integration_account", { p_organization_id: orgId, p_kind: "payments", p_provider: "razorpay", p_account_id: "acc_evil", p_active: true, p_correlation_id: corr() }],
      ["delivery", "save_contract_template", { p_organization_id: orgId, p_key: "evil", p_name: "Evil", p_body: "x".repeat(60), p_correlation_id: corr() }],
      ["cto", "run_billing_checks", { p_organization_id: orgId, p_correlation_id: corr() }],
    ];
    for (const [who, fn, args] of checks) {
      const result = await c[who].rpc(fn as "run_billing_checks", args as never);
      expect(result.error?.message, `${who} ${fn}`).toBe("FORBIDDEN");
    }
    const exceptions = await c.delivery.rpc("integration_exceptions", { p_organization_id: orgId });
    expect(exceptions.error?.message).toBe("FORBIDDEN");
    const ctoExceptions = await c.cto.rpc("integration_exceptions", { p_organization_id: orgId });
    expect(ctoExceptions.error).toBeNull();
    expect(JSON.stringify(ctoExceptions.data)).not.toContain("amount");
  });
});
