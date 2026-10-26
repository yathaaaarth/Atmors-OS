/**
 * Phase 3 SQL rules on an in-process Postgres: shared booking (AT-010/011),
 * contracts and signature events (AT-012–014), payments and the activation
 * evaluator (AT-015–020). RLS and grants are covered against real Supabase
 * in tests/security/phase3.test.ts.
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { scheduleAmounts, type ScheduleItem } from "@/modules/proposals/money";

import { migratedDatabase } from "../support/pglite-db";

type Db = Awaited<ReturnType<typeof migratedDatabase>>;
type Row = Record<string, unknown>;

const CONTENT = JSON.stringify({
  summary: "Grow pipeline",
  scope: "LinkedIn content",
  deliverables: ["12 posts a month"],
  exclusions: ["Paid ads"],
  terms: "Net 7",
});
const SCHEDULE = JSON.stringify([
  { label: "Deposit", basis: "percent", percent_bps: 5000, due: "on_signing" },
  { label: "Balance", basis: "percent", percent_bps: 5000, due: "on_milestone", milestone: "Month 1" },
]);
// 1,000.00 + 18% tax = 1,180.00 -> two instalments of 590.00
const LINES = JSON.stringify([{ title: "Content", quantity: 1, unit_amount_minor: 100000, tax_rate_bps: 1800 }]);
const EVERY_DAY = JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: "00:00", end: "23:59" })));
const LEGAL = JSON.stringify({
  client_legal_name: "Acme Private Limited",
  client_address: "12 MG Road, Bengaluru 560001",
  client_tax_id: "29ABCDE1234F1Z5",
  signer_name: "Asha Founder",
  signer_email: "founder@acme.test",
});

const hex = (char: string) => char.repeat(64);
const tokenHash = (label: string) => createHash("sha256").update(label).digest("hex");
let counter = 0;
const key = (label: string) => `${label}-${++counter}-idempotency`;

describe("Phase 3 SQL rules (PGlite)", () => {
  let d: Db;
  const u: Record<string, string> = {};
  let org: string;
  let prospect: string;
  let template: string;

  async function one<T extends Row = Row>(user: string | null, sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await d.as<T>(user, sql, params);
    return row;
  }

  async function acceptedProposal(tokenChar: string) {
    const proposal = await one<{ id: string; current_version_id: string }>(
      u.sales,
      `select * from create_proposal($1, 'Retainer', 'INR', 'c')`,
      [prospect],
    );
    const versionId = proposal.current_version_id;
    await d.as(
      u.sales,
      `select save_proposal_draft($1, 'Retainer', 'INR', current_date + 10, $2::jsonb, $3::jsonb, $4::jsonb, '{}', false, false, 'c')`,
      [versionId, CONTENT, SCHEDULE, LINES],
    );
    await d.as(u.sales, `select submit_proposal_version($1, 'c')`, [versionId]);
    await d.as(u.sales, `select send_proposal_version($1, 'c')`, [versionId]);
    await d.as(u.sales, `select create_invitation($1, $2, $3, 14, 'c')`, [prospect, proposal.id, tokenHash(tokenChar)]);
    await d.as(u.client, `select redeem_invitation($1, 'c')`, [tokenHash(tokenChar)]);
    const { hash } = await one<{ hash: string }>(null, `select content_hash as hash from proposal_versions where id = $1`, [versionId]);
    await d.as(u.client, `select accept_proposal($1, $2, $3, 'c')`, [proposal.id, versionId, hash]);
    return { proposalId: proposal.id, versionId };
  }

  async function generate(proposalId: string, legal = LEGAL) {
    return one<{ id: string; checksum: string; rendered_document: string; status: string; proposal_version_id: string; template_version: number }>(
      u.ceo,
      `select * from generate_contract($1, $2, $3::jsonb, $4, null, 'c')`,
      [proposalId, template, legal, u.ceo],
    );
  }

  async function signatureEvent(contractId: string, eventId: string, type: string, role: string, email: string, verified = true) {
    const { r } = await one<{ r: { status: string; error_code: string | null } }>(
      null,
      `select ingest_signature_event('sandbox', $1, $2, $3, $4, (select provider_document_id from contracts where id = $5),
         jsonb_build_object('signer_role', $6::text, 'signer_email', $7::text), now(), 'c') as r`,
      [eventId, type, verified, hex("e"), contractId, role, email],
    );
    return r;
  }

  async function paymentEvent(eventId: string, type: string, data: Record<string, unknown>, verified = true) {
    const { r } = await one<{ r: { status: string; error_code: string | null } }>(
      null,
      `select ingest_payment_event('sandbox', $1, $2, $3, $4, $5::jsonb, 'c') as r`,
      [eventId, type, verified, hex("f"), JSON.stringify({ account_id: "acc_sandbox", currency: "INR", ...data })],
    );
    return r;
  }

  /** Executed contract with the deposit invoice issued. */
  async function executedContract(tokenChar: string) {
    const { proposalId, versionId } = await acceptedProposal(tokenChar);
    const contract = await generate(proposalId);
    await d.as(u.ceo, `select transition_contract($1, 'mark_ready', null, 'c')`, [contract.id]);
    await d.as(u.ceo, `select record_contract_sent($1, 'sandbox', $2, 'c')`, [contract.id, `sbx_doc_${contract.id}`]);
    await signatureEvent(contract.id, `sig-client-${contract.id}`, "signer.signed", "client", "founder@acme.test");
    await signatureEvent(contract.id, `sig-atmors-${contract.id}`, "signer.signed", "atmors", "ceo@atmors.test");
    const invoice = await one<{ id: string; total_minor: number }>(
      null,
      `select i.* from invoices i join payment_schedule_items s on s.id = i.schedule_item_id
       where i.contract_id = $1 and s.position = 0`,
      [contract.id],
    );
    return { contract, proposalId, versionId, invoice };
  }

  async function startPayment(invoiceId: string, amount: number | null = null) {
    const { r } = await one<{ r: { payment_id: string } }>(
      u.client,
      `select client_start_payment($1, 'sandbox', $2, $3, 'c') as r`,
      [invoiceId, amount, key("pay")],
    );
    const order = `sbx_order_${r.payment_id}`;
    await d.as(null, `select attach_payment_order($1, $2)`, [r.payment_id, order]);
    return { paymentId: r.payment_id, order };
  }

  const invoiceRow = (id: string) =>
    one<{ status: string; paid_minor: number; balance_minor: number; total_minor: number }>(null, `select * from invoices where id = $1`, [id]);
  const contractRow = (id: string) =>
    one<{ status: string; activation_eligible: boolean; rendered_document: string }>(null, `select * from contracts where id = $1`, [id]);

  beforeAll(async () => {
    d = await migratedDatabase();
    for (const [name, email] of Object.entries({
      ceo: "ceo@atmors.test",
      cto: "cto@atmors.test",
      sales: "sales@atmors.test",
      delivery: "delivery@atmors.test",
      client: "founder@acme.test",
      stranger: "someone@else.test",
    })) {
      ({ id: u[name] } = await one<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [email]));
      await d.as(null, `update profiles set display_name = $2 where id = $1`, [u[name], `${name} person`]);
    }
    ({ id: org } = await one<{ id: string }>(null, `insert into organizations (name, slug) values ('Atmors', 'atmors') returning id`));
    await d.as(
      null,
      `insert into organization_memberships (organization_id, user_id, role)
       values ($1, $2, 'ceo'), ($1, $3, 'cto_coo'), ($1, $4, 'sales'), ($1, $5, 'delivery')`,
      [org, u.ceo, u.cto, u.sales, u.delivery],
    );
    ({ id: prospect } = await one<{ id: string }>(
      u.sales,
      `select id from create_prospect($1, $2, 'Asha Founder', 'Acme', 'founder@acme.test', 'email', null, null, null, null, null, 'c')`,
      [org, u.sales],
    ));
    // New organizations get the default (draft) agreement template.
    ({ id: template } = await one<{ id: string }>(null, `select id from contract_templates where organization_id = $1 and active`, [org]));
    await d.as(u.cto, `select save_booking_host($1, $2, '{commercial}', 'Asia/Kolkata', $3::jsonb, 30, 0, 14, true, 'c')`, [
      org,
      u.sales,
      EVERY_DAY,
    ]);
    await d.as(u.ceo, `select configure_integration_account($1, 'esign', 'sandbox', 'sandbox', true, 'c')`, [org]);
    await d.as(u.ceo, `select configure_integration_account($1, 'payments', 'sandbox', 'acc_sandbox', true, 'c')`, [org]);
  });

  describe("shared booking", () => {
    let token: string;
    let slots: { start_at: string }[];

    beforeAll(async () => {
      token = hex("b");
      await d.as(u.sales, `select create_invitation($1, null, $2, 14, 'c')`, [prospect, token]);
      const { r } = await one<{ r: { state: string; slots: { start_at: string }[] } }>(
        null,
        `select booking_options_with_token($1, 'commercial', now(), now() + interval '3 days') as r`,
        [token],
      );
      expect(r.state).toBe("valid");
      slots = r.slots;
      expect(slots.length).toBeGreaterThan(10);
    });

    it("only hosts with weekly hours, routing and timezone produce slots", async () => {
      const { r } = await one<{ r: { slots: unknown[] } }>(
        null,
        `select booking_options_with_token($1, 'onboarding', now(), now() + interval '3 days') as r`,
        [token],
      );
      expect(r.slots).toEqual([]); // nobody takes onboarding calls yet
      const { r: bad } = await one<{ r: { state: string } }>(
        null,
        `select booking_options_with_token($1, 'commercial', now(), now() + interval '1 day') as r`,
        [hex("0")],
      );
      expect(bad.state).toBe("invalid");
    });

    it("AT-010: two bookings for the same host and time cannot both confirm", async () => {
      const start = slots[2].start_at;
      const book = (k: string) =>
        one<{ r: { status: string; replayed?: boolean; alternatives?: { start_at: string }[] } }>(
          null,
          `select book_meeting_with_token($1, 'commercial', $2, 'Europe/London', null, $3, 'c') as r`,
          [token, start, k],
        );
      const first = await book(key("book"));
      expect(first.r.status).toBe("booked");
      const firstKey = key("book");
      const second = await book(firstKey);
      expect(second.r.status).toBe("slot_unavailable");
      expect(second.r.alternatives!.length).toBeGreaterThan(0);
      expect(second.r.alternatives!.map((slot) => slot.start_at)).not.toContain(start);

      // The database refuses an overlapping booking even if code skipped the checks.
      expect(
        await d.errorOf(
          null,
          `insert into meetings (organization_id, prospect_id, purpose, host_user_id, start_at, end_at, timezone, idempotency_key, booked_by_type)
           values ($1, $2, 'commercial', $3, $4::timestamptz + interval '10 minutes', $4::timestamptz + interval '40 minutes', 'UTC', 'raw-insert-key', 'system')`,
          [org, prospect, u.sales, start],
        ),
      ).toMatch(/meetings_no_host_overlap/);
    });

    it("replays a retried booking instead of creating a second one", async () => {
      const k = key("book");
      const start = slots[4].start_at;
      const sql = `select book_meeting_with_token($1, 'commercial', $2, 'Asia/Kolkata', 'Keen to talk', $3, 'c') as r`;
      const first = await one<{ r: { status: string } }>(null, sql, [token, start, k]);
      const again = await one<{ r: { status: string; replayed: boolean } }>(null, sql, [token, start, k]);
      expect(first.r.status).toBe("booked");
      expect(again.r).toMatchObject({ status: "booked", replayed: true });
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from meetings where idempotency_key = $1`, [k]);
      expect(n).toBe(1);
    });

    it("rejects an unknown timezone", async () => {
      expect(
        await d.errorOf(null, `select book_meeting_with_token($1, 'commercial', $2, 'Mars/Olympus', null, $3, 'c')`, [
          token,
          slots[6].start_at,
          key("book"),
        ]),
      ).toBe("VALIDATION_FAILED");
    });

    it("AT-011: a callback request becomes one internal task for the owner", async () => {
      const k = key("callback");
      const sql = `select request_callback_with_token($1, 'commercial', 'No slot works, call me Friday', $2, 'c')`;
      await d.as(null, sql, [token, k]);
      await d.as(null, sql, [token, k]);
      const tasks = await d.as<{ owner_user_id: string; visibility: string; status: string }>(
        null,
        `select * from ops_tasks where kind = 'callback_request' and dedupe_key = $1`,
        [`callback:${k}`],
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ owner_user_id: u.sales, visibility: "commercial", status: "open" });
      // Unknown tokens get the same silent response and create nothing.
      await d.as(null, sql, [hex("9"), key("callback")]);
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'callback_request'`);
      expect(n).toBe(1);
    });

    it("lets a signed-in client reschedule and cancel; staff close out only after start", async () => {
      await acceptedProposal("c"); // gives the client portal access to this prospect
      const booked = await one<{ r: { meeting: { id: string } } }>(
        u.client,
        `select client_book_meeting(null, 'commercial', $1, 'Asia/Kolkata', null, $2, 'c') as r`,
        [slots[8].start_at, key("book")],
      );
      const meetingId = booked.r.meeting.id;
      const moved = await one<{ r: { status: string } }>(
        u.client,
        `select client_change_meeting($1, 'reschedule', $2, null, 'c') as r`,
        [meetingId, slots[9].start_at],
      );
      expect(moved.r.status).toBe("booked");
      expect((await one<{ status: string }>(null, `select status from meetings where id = $1`, [meetingId])).status).toBe("rescheduled");

      expect(await d.errorOf(u.sales, `select update_meeting($1, 'complete', null, null, 'c')`, [meetingId])).toBe(
        "INVALID_STATE_TRANSITION",
      );
      expect(await d.errorOf(u.delivery, `select update_meeting($1, 'cancel', null, 'not mine', 'c')`, [meetingId])).toBe("FORBIDDEN");
      expect(await d.errorOf(u.stranger, `select client_change_meeting($1, 'cancel', null, null, 'c')`, [meetingId])).toBe("NOT_FOUND");
      await d.as(u.client, `select client_change_meeting($1, 'cancel', null, 'Clash', 'c')`, [meetingId]);
      const events = await d.as<{ event_type: string }>(null, `select event_type from meeting_events where meeting_id = $1 order by occurred_at`, [
        meetingId,
      ]);
      expect(events.map((event) => event.event_type)).toEqual(["meeting.booked", "meeting.rescheduled", "meeting.cancelled"]);
    });

    it("only scheduling admins change routing; hosts may edit their own hours", async () => {
      expect(
        await d.errorOf(u.sales, `select save_booking_host($1, $2, '{commercial,onboarding}', 'Asia/Kolkata', $3::jsonb, 30, 0, 14, true, 'c')`, [
          org,
          u.sales,
          EVERY_DAY,
        ]),
      ).toBe("FORBIDDEN");
      expect(
        await d.errorOf(u.sales, `select save_booking_host($1, $2, '{commercial}', 'Asia/Kolkata', $3::jsonb, 30, 0, 14, true, 'c')`, [
          org,
          u.sales,
          EVERY_DAY,
        ]),
      ).toBeNull();
      expect(
        await d.errorOf(u.cto, `select save_booking_host($1, $2, '{commercial}', 'Asia/Kolkata', '[{"day": 8, "start": "09:00", "end": "10:00"}]', 30, 0, 14, true, 'c')`, [
          org,
          u.sales,
        ]),
      ).toBe("VALIDATION_FAILED");
    });
  });

  describe("contracts", () => {
    it("AT-012: generates from the exact accepted version with checksum and template version", async () => {
      const { proposalId, versionId } = await acceptedProposal("d");
      expect(await d.errorOf(u.sales, `select generate_contract($1, $2, $3::jsonb, $4, null, 'c')`, [proposalId, template, LEGAL, u.ceo])).toBe(
        "FORBIDDEN",
      );
      const contract = await generate(proposalId);
      expect(contract.status).toBe("draft");
      expect(contract.proposal_version_id).toBe(versionId);
      expect(contract.template_version).toBe(1);
      const { digest } = await one<{ digest: string }>(null, `select encode(sha256(convert_to($1, 'UTF8')), 'hex') as digest`, [
        contract.rendered_document,
      ]);
      expect(contract.checksum).toBe(digest);
      expect(contract.rendered_document).toContain("Acme Private Limited");
      expect(contract.rendered_document).toContain("version 1");
      expect(contract.rendered_document).toContain("INR 1,180.00");
      expect(contract.rendered_document).toContain("- Paid ads");
      expect(contract.rendered_document).not.toMatch(/\{\{/);
      // One live agreement per accepted version.
      expect(await d.errorOf(u.ceo, `select generate_contract($1, $2, $3::jsonb, $4, null, 'c')`, [proposalId, template, LEGAL, u.ceo])).toBe(
        "CONFLICT",
      );
    });

    it("refuses unaccepted proposals and signers who cannot sign in", async () => {
      const proposal = await one<{ id: string }>(u.sales, `select * from create_proposal($1, 'Draft only', 'INR', 'c')`, [prospect]);
      expect(await d.errorOf(u.ceo, `select generate_contract($1, $2, $3::jsonb, $4, null, 'c')`, [proposal.id, template, LEGAL, u.ceo])).toBe(
        "INVALID_STATE_TRANSITION",
      );
      const { proposalId } = await acceptedProposal("e");
      const outsider = JSON.stringify({ ...JSON.parse(LEGAL), signer_email: "someone@else.test" });
      expect(await d.errorOf(u.ceo, `select generate_contract($1, $2, $3::jsonb, $4, null, 'c')`, [proposalId, template, outsider, u.ceo])).toBe(
        "VALIDATION_FAILED",
      );
      expect(await d.errorOf(u.ceo, `select generate_contract($1, $2, $3::jsonb, $4, null, 'c')`, [proposalId, template, LEGAL, u.delivery])).toBe(
        "VALIDATION_FAILED",
      );
    });

    it("AT-018: materializes the agreement's schedule and activation condition", async () => {
      const { proposalId } = await acceptedProposal("f");
      const contract = await generate(proposalId);
      const items = await d.as<{ amount_minor: number; due_rule: string; activation_relevant: boolean }>(
        null,
        `select * from payment_schedule_items where contract_id = $1 order by position`,
        [contract.id],
      );
      expect(items.map((item) => [Number(item.amount_minor), item.due_rule, item.activation_relevant])).toEqual([
        [59000, "on_signing", true],
        [59000, "on_milestone", false],
      ]);
      const { policy } = await one<{ policy: Row }>(null, `select activation_policy as policy from contracts where id = $1`, [contract.id]);
      expect(policy).toEqual({
        required_contract_state: "executed",
        required_payment_items: [0],
        required_onboarding_state: "not_required",
        required_manual_review: false,
      });
    });

    it("splits schedules exactly like the TypeScript preview", async () => {
      const cases: [ScheduleItem[], number][] = [
        [
          [
            { label: "A", basis: "percent", percent_bps: 3333, due: "on_signing" },
            { label: "B", basis: "percent", percent_bps: 3333, due: "on_signing" },
            { label: "C", basis: "percent", percent_bps: 3334, due: "on_signing" },
          ],
          100001,
        ],
        [
          [
            { label: "A", basis: "percent", percent_bps: 2550, due: "on_signing" },
            { label: "B", basis: "percent", percent_bps: 7450, due: "on_signing" },
          ],
          99999,
        ],
        [
          [
            { label: "A", basis: "fixed", amount_minor: 1000, due: "on_signing" },
            { label: "B", basis: "fixed", amount_minor: 2500, due: "on_signing" },
          ],
          3500,
        ],
      ];
      for (const [schedule, total] of cases) {
        const { amounts } = await one<{ amounts: string[] }>(null, `select private.schedule_amounts($1::jsonb, $2) as amounts`, [
          JSON.stringify(schedule),
          total,
        ]);
        expect(amounts.map(Number)).toEqual(scheduleAmounts(schedule, total));
      }
    });

    it("AT-013/014: signing flow, quarantined forgeries, immutability and amendments", async () => {
      const { proposalId } = await acceptedProposal("g");
      const contract = await generate(proposalId);
      await d.as(u.ceo, `select transition_contract($1, 'mark_ready', null, 'c')`, [contract.id]);
      // Content freezes once ready.
      expect(await d.errorOf(null, `update contracts set rendered_document = 'tampered' where id = $1`, [contract.id])).toBe(
        "INVALID_STATE_TRANSITION",
      );
      await d.as(u.ceo, `select record_contract_sent($1, 'sandbox', $2, 'c')`, [contract.id, `sbx_doc_${contract.id}`]);

      const view = await one<{ v: { status: string; can_sign: boolean; rendered_document: string } }>(
        u.client,
        `select client_contract_view($1) as v`,
        [contract.id],
      );
      expect(view.v).toMatchObject({ status: "viewed", can_sign: true });
      expect(await d.errorOf(u.client, `select client_prepare_signature($1, $2, 'c')`, [contract.id, hex("0")])).toBe("VERSION_STALE");
      expect(await d.errorOf(u.stranger, `select client_prepare_signature($1, $2, 'c')`, [contract.id, contract.checksum])).toBe("NOT_FOUND");
      expect(await d.errorOf(u.ceo, `select prepare_countersignature($1, $2, 'c')`, [contract.id, contract.checksum])).toBe(
        "INVALID_STATE_TRANSITION",
      );
      expect(await d.errorOf(u.client, `select client_prepare_signature($1, $2, 'c')`, [contract.id, contract.checksum])).toBeNull();

      // AT-014: an unverified event is recorded, quarantined and changes nothing.
      const forged = await signatureEvent(contract.id, `forged-${contract.id}`, "document.completed", "client", "founder@acme.test", false);
      expect(forged).toMatchObject({ status: "quarantined", error_code: "SIGNATURE_INVALID" });
      expect((await contractRow(contract.id)).status).toBe("viewed");

      const signed = await signatureEvent(contract.id, `sig-1-${contract.id}`, "signer.signed", "client", "founder@acme.test");
      expect(signed.status).toBe("processed");
      expect((await contractRow(contract.id)).status).toBe("partially_signed");
      expect((await signatureEvent(contract.id, `sig-1-${contract.id}`, "signer.signed", "client", "founder@acme.test")).status).toBe("duplicate");
      const wrongSigner = await signatureEvent(contract.id, `sig-x-${contract.id}`, "signer.signed", "atmors", "intruder@evil.test");
      expect(wrongSigner).toMatchObject({ status: "quarantined", error_code: "SIGNER_MISMATCH" });

      expect(await d.errorOf(u.ceo, `select prepare_countersignature($1, $2, 'c')`, [contract.id, contract.checksum])).toBeNull();
      await signatureEvent(contract.id, `sig-2-${contract.id}`, "signer.signed", "atmors", "ceo@atmors.test");
      expect((await contractRow(contract.id)).status).toBe("executed");

      // AT-013: executed agreements cannot change in place.
      expect(await d.errorOf(null, `update contracts set status = 'voided' where id = $1`, [contract.id])).toBe("INVALID_STATE_TRANSITION");
      expect(await d.errorOf(u.ceo, `select transition_contract($1, 'void', 'changed mind', 'c')`, [contract.id])).toBe(
        "INVALID_STATE_TRANSITION",
      );
      expect(await d.errorOf(null, `delete from contracts where id = $1`, [contract.id])).toBe("INVALID_STATE_TRANSITION");
      const amendment = await one<{ id: string; supersedes_contract_id: string; status: string; checksum: string; rendered_document: string }>(
        u.ceo,
        `select * from create_contract_amendment($1, 'Add a second channel', 'Scope now includes a newsletter each month.', 'c')`,
        [contract.id],
      );
      expect(amendment).toMatchObject({ supersedes_contract_id: contract.id, status: "draft" });
      expect(amendment.checksum).not.toBe(contract.checksum);
      expect(amendment.rendered_document).toContain("AMENDMENT");
      expect((await contractRow(contract.id)).status).toBe("executed");
    });
  });

  describe("payments and activation", () => {
    it("AT-017: the client sees pending until a verified event arrives, then paid once", async () => {
      const { contract, invoice } = await executedContract("h");
      expect(await invoiceRow(invoice.id)).toMatchObject({ status: "issued", balance_minor: 59000 });
      const { paymentId, order } = await startPayment(invoice.id);
      const pending = await one<{ s: { status: string; invoice_status: string } }>(u.client, `select client_payment_status($1) as s`, [paymentId]);
      expect(pending.s).toMatchObject({ status: "pending", invoice_status: "issued" });

      const before = await one<{ r: { eligible: boolean; blocking_reasons: string[] } }>(
        u.ceo,
        `select evaluate_contract_activation($1, 'c') as r`,
        [contract.id],
      );
      expect(before.r).toMatchObject({ eligible: false, blocking_reasons: ["payment_item_unpaid:0"] });

      const result = await paymentEvent(`pay-ok-${paymentId}`, "payment.succeeded", {
        provider_order_id: order,
        provider_payment_id: `sbx_pay_${paymentId}`,
        amount_minor: 59000,
      });
      expect(result.status).toBe("processed");
      expect(await invoiceRow(invoice.id)).toMatchObject({ status: "paid", balance_minor: 0 });
      expect((await contractRow(contract.id)).activation_eligible).toBe(true);
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'kickoff_ready' and related_id = $1`, [
        contract.id,
      ]);
      expect(n).toBe(1);
    });

    it("AT-015: replayed or repeated success events never double count", async () => {
      const { invoice } = await executedContract("i");
      const { paymentId, order } = await startPayment(invoice.id);
      const data = { provider_order_id: order, provider_payment_id: `sbx_pay_${paymentId}`, amount_minor: 59000 };
      expect((await paymentEvent(`dup-${paymentId}`, "payment.succeeded", data)).status).toBe("processed");
      expect((await paymentEvent(`dup-${paymentId}`, "payment.succeeded", data)).status).toBe("duplicate");
      expect((await paymentEvent(`dup-other-${paymentId}`, "payment.succeeded", data)).status).toBe("duplicate");
      expect(await invoiceRow(invoice.id)).toMatchObject({ status: "paid", paid_minor: 59000 });
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'kickoff_ready' and prospect_id = $1`, [
        prospect,
      ]);
      expect(n).toBeLessThanOrEqual(2); // one per executed contract in this suite, never per event
    });

    it("AT-016: wrong amount, currency or account is quarantined and leaves the invoice unpaid", async () => {
      const { invoice } = await executedContract("j");
      const { paymentId, order } = await startPayment(invoice.id);
      const base = { provider_order_id: order, provider_payment_id: `sbx_pay_${paymentId}`, amount_minor: 59000 };
      expect(await paymentEvent(`mm-1-${paymentId}`, "payment.succeeded", { ...base, amount_minor: 100 })).toMatchObject({
        status: "quarantined",
        error_code: "PAYMENT_MISMATCH",
      });
      expect(await paymentEvent(`mm-2-${paymentId}`, "payment.succeeded", { ...base, currency: "USD" })).toMatchObject({
        status: "quarantined",
        error_code: "PAYMENT_MISMATCH",
      });
      expect(await paymentEvent(`mm-3-${paymentId}`, "payment.succeeded", { ...base, account_id: "acc_attacker" })).toMatchObject({
        status: "quarantined",
        error_code: "PAYMENT_MISMATCH",
      });
      expect(await paymentEvent(`mm-4-${paymentId}`, "payment.succeeded", { ...base, provider_order_id: "sbx_order_unknown" })).toMatchObject({
        status: "quarantined",
        error_code: "UNKNOWN_PAYMENT",
      });
      expect(await invoiceRow(invoice.id)).toMatchObject({ status: "issued", paid_minor: 0 });
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'payment_exception'`);
      expect(n).toBeGreaterThanOrEqual(3);

      // AT-014 for payments: a forged event is quarantined and cannot be replayed.
      const forged = await paymentEvent(`forged-${paymentId}`, "payment.succeeded", base, false);
      expect(forged).toMatchObject({ status: "quarantined", error_code: "SIGNATURE_INVALID" });
      const { id: forgedId } = await one<{ id: string }>(null, `select id from payment_events where provider_event_id = $1`, [`forged-${paymentId}`]);
      expect(await d.errorOf(u.ceo, `select reprocess_payment_event($1, 'c')`, [forgedId])).toBe("FORBIDDEN"); // no organization link
      // A forged event does not reserve the ID: the genuine event still processes.
      expect((await paymentEvent(`forged-${paymentId}`, "payment.succeeded", base)).status).toBe("processed");
      expect(await invoiceRow(invoice.id)).toMatchObject({ status: "paid" });
    });

    it("AT-019: failed and partial payments keep balance and activation consistent", async () => {
      const { contract } = await executedContract("k");
      const { id: balanceItem } = await one<{ id: string }>(
        null,
        `select id from payment_schedule_items where contract_id = $1 and position = 1`,
        [contract.id],
      );
      expect(await d.errorOf(u.cto, `select issue_invoice_for_item($1, 7, true, 'c')`, [balanceItem])).toBe("FORBIDDEN");
      const balance = await one<{ id: string }>(u.ceo, `select * from issue_invoice_for_item($1, 7, true, 'c')`, [balanceItem]);
      expect(await d.errorOf(u.client, `select client_start_payment($1, 'sandbox', 70000, $2, 'c')`, [balance.id, key("pay")])).toBe(
        "VALIDATION_FAILED",
      );

      const failed = await startPayment(balance.id, 20000);
      await paymentEvent(`fail-${failed.paymentId}`, "payment.failed", { provider_order_id: failed.order, failure_code: "BAD_REQUEST_ERROR" });
      expect((await one<{ status: string }>(null, `select status from payments where id = $1`, [failed.paymentId])).status).toBe("failed");
      expect(await invoiceRow(balance.id)).toMatchObject({ status: "issued", balance_minor: 59000 });

      const partial = await startPayment(balance.id, 20000);
      await paymentEvent(`part-${partial.paymentId}`, "payment.succeeded", {
        provider_order_id: partial.order,
        provider_payment_id: `sbx_pay_${partial.paymentId}`,
        amount_minor: 20000,
      });
      expect(await invoiceRow(balance.id)).toMatchObject({ status: "partially_paid", paid_minor: 20000, balance_minor: 39000 });
      // The deposit is still unpaid, so activation stays blocked on it alone.
      const evaluation = await one<{ r: { eligible: boolean; blocking_reasons: string[] } }>(
        u.cto,
        `select evaluate_contract_activation($1, 'c') as r`,
        [contract.id],
      );
      expect(evaluation.r).toMatchObject({ eligible: false, blocking_reasons: ["payment_item_unpaid:0"] });
    });

    it("AT-020: refunds and disputes adjust history, reopen balances and trigger review", async () => {
      const { contract, invoice } = await executedContract("l");
      const { paymentId, order } = await startPayment(invoice.id);
      const providerPaymentId = `sbx_pay_${paymentId}`;
      await paymentEvent(`r-ok-${paymentId}`, "payment.succeeded", { provider_order_id: order, provider_payment_id: providerPaymentId, amount_minor: 59000 });
      expect((await contractRow(contract.id)).activation_eligible).toBe(true);

      const refund = { provider_payment_id: providerPaymentId, refund_id: `rfnd_${paymentId}`, amount_minor: 9000 };
      expect((await paymentEvent(`r-1-${paymentId}`, "refund.processed", refund)).status).toBe("processed");
      expect((await paymentEvent(`r-2-${paymentId}`, "refund.processed", refund)).status).toBe("duplicate"); // same refund, new event ID
      expect(await invoiceRow(invoice.id)).toMatchObject({ status: "partially_paid", paid_minor: 50000, balance_minor: 9000 });
      const payment = await one<{ amount_minor: number; refunded_minor: number; status: string }>(null, `select * from payments where id = $1`, [
        paymentId,
      ]);
      expect(payment).toMatchObject({ status: "succeeded" });
      expect([Number(payment.amount_minor), Number(payment.refunded_minor)]).toEqual([59000, 9000]);
      expect((await contractRow(contract.id)).activation_eligible).toBe(false);
      const reviews = await d.as(null, `select * from ops_tasks where kind = 'payment_review' and related_id = $1`, [paymentId]);
      expect(reviews).toHaveLength(1);
      expect(await d.errorOf(null, `delete from payment_adjustments`)).toBe("APPEND_ONLY");

      const dispute = { provider_payment_id: providerPaymentId, dispute_id: `disp_${paymentId}`, amount_minor: 50000 };
      await paymentEvent(`d-1-${paymentId}`, "dispute.opened", dispute);
      expect((await invoiceRow(invoice.id)).status).toBe("disputed");
      await paymentEvent(`d-2-${paymentId}`, "dispute.lost", dispute);
      const lost = await one<{ status: string; refunded_minor: number }>(null, `select * from payments where id = $1`, [paymentId]);
      expect(lost.status).toBe("refunded");
      expect(Number(lost.refunded_minor)).toBe(59000);
      expect(await invoiceRow(invoice.id)).toMatchObject({ status: "issued", paid_minor: 0, balance_minor: 59000 });
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from payment_adjustments where payment_id = $1`, [paymentId]);
      expect(n).toBe(3); // refund, dispute opened, dispute lost: history kept, never erased
    });

    it("records manual reconciliation visibly and only with billing authority", async () => {
      const { invoice } = await executedContract("m");
      expect(await d.errorOf(u.cto, `select record_manual_payment($1, 59000, 'NEFT 1234', 'Bank transfer received', 'c')`, [invoice.id])).toBe(
        "FORBIDDEN",
      );
      const payment = await one<{ manual: boolean; provider: string; status: string }>(
        u.ceo,
        `select * from record_manual_payment($1, 59000, 'NEFT 1234', 'Bank transfer received', 'manual-corr')`,
        [invoice.id],
      );
      expect(payment).toMatchObject({ manual: true, provider: "manual", status: "succeeded" });
      expect((await invoiceRow(invoice.id)).status).toBe("paid");
      const audit = await one<{ after_summary: { override: boolean }; reason: string }>(
        null,
        `select * from audit_logs where correlation_id = 'manual-corr' and action = 'payment.manual_recorded'`,
      );
      expect(audit).toMatchObject({ after_summary: { override: true }, reason: "Bank transfer received" });
    });

    it("keeps provider evidence immutable and refuses payments for disabled providers", async () => {
      const { invoice } = await executedContract("n");
      await paymentEvent("evidence-row", "payment.succeeded", { provider_order_id: "none" });
      expect(await d.errorOf(null, `update payment_events set data = '{}'::jsonb`)).toBe("APPEND_ONLY");
      expect(await d.errorOf(null, `delete from signature_events`)).toBe("APPEND_ONLY");
      expect(await d.errorOf(u.client, `select client_start_payment($1, 'razorpay', null, $2, 'c')`, [invoice.id, key("pay")])).toBe(
        "PROVIDER_UNAVAILABLE",
      );
      expect(await d.errorOf(u.stranger, `select client_start_payment($1, 'sandbox', null, $2, 'c')`, [invoice.id, key("pay")])).toBe(
        "NOT_FOUND",
      );
    });
  });
});
