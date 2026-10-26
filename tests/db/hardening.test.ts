/**
 * Phase 6 hardening on PGlite: catalog-wide security invariants (every table
 * under RLS, no anonymous table access, definer functions pinned to a search
 * path, nothing executable by PUBLIC), notification idempotency and retry
 * (AT-031), and audit completeness across the journey (AT-032).
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { migratedDatabase } from "../support/pglite-db";

type Db = Awaited<ReturnType<typeof migratedDatabase>>;
type Row = Record<string, unknown>;
const hash = (label: string) => createHash("sha256").update(label).digest("hex");

describe("Phase 6 hardening (PGlite)", () => {
  let d: Db;
  const u: Record<string, string> = {};
  let org: string;
  let prospect: string;
  let contractId: string;
  let workspaceId: string;

  async function one<T extends Row = Row>(user: string | null, sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await d.as<T>(user, sql, params);
    return row;
  }

  beforeAll(async () => {
    d = await migratedDatabase();
    for (const [name, email] of Object.entries({ ceo: "ceo@atmors.test", cto: "cto@atmors.test", sales: "sales@atmors.test", client: "founder@acme.test" })) {
      ({ id: u[name] } = await one<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [email]));
      await d.as(null, `update profiles set email = $2 where id = $1`, [u[name], email]);
    }
    ({ id: org } = await one<{ id: string }>(null, `insert into organizations (name, slug) values ('Atmors', 'atmors') returning id`));
    await d.as(null, `insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'ceo'), ($1, $3, 'cto_coo'), ($1, $4, 'sales')`, [
      org, u.ceo, u.cto, u.sales,
    ]);
    await d.as(u.ceo, `select configure_integration_account($1, 'esign', 'sandbox', 'sandbox', true, 'c')`, [org]);
    ({ id: prospect } = await one<{ id: string }>(u.sales, `select id from create_prospect($1, $2, 'Founder', 'Acme', 'founder@acme.test', 'email', null, null, null, null, null, 'corr-prospect')`, [org, u.sales]));

    // The full journey, each step under its own correlation ID.
    const proposal = await one<{ id: string; current_version_id: string }>(u.sales, `select * from create_proposal($1, 'Retainer', 'INR', 'corr-proposal')`, [prospect]);
    const v = proposal.current_version_id;
    await d.as(u.sales, `select save_proposal_draft($1, 'Retainer', 'INR', current_date + 10, $2::jsonb, $3::jsonb, $4::jsonb, '{}', false, false, 'corr-draft')`, [
      v,
      JSON.stringify({ summary: "S", scope: "S" }),
      JSON.stringify([{ label: "All", basis: "percent", percent_bps: 10000, due: "on_signing" }]),
      JSON.stringify([{ title: "Work", quantity: 1, unit_amount_minor: 100000, tax_rate_bps: 1800 }]),
    ]);
    await d.as(u.sales, `select submit_proposal_version($1, 'corr-submit')`, [v]);
    await d.as(u.sales, `select send_proposal_version($1, 'corr-send')`, [v]);
    await d.as(u.sales, `select create_invitation($1, $2, $3, 14, 'corr-invite')`, [prospect, proposal.id, hash("t1")]);
    await d.as(u.client, `select redeem_invitation($1, 'corr-redeem')`, [hash("t1")]);
    const { h } = await one<{ h: string }>(null, `select content_hash as h from proposal_versions where id = $1`, [v]);
    await d.as(u.client, `select accept_proposal($1, $2, $3, 'corr-accept')`, [proposal.id, v, h]);
    const { id: template } = await one<{ id: string }>(null, `select id from contract_templates where organization_id = $1 and active`, [org]);
    ({ id: contractId } = await one<{ id: string }>(u.ceo, `select * from generate_contract($1, $2, $3::jsonb, $4, null, 'corr-contract')`, [
      proposal.id, template,
      JSON.stringify({ client_legal_name: "Acme Pvt Ltd", client_address: "1 MG Road, Pune", signer_name: "Founder", signer_email: "founder@acme.test" }),
      u.ceo,
    ]));
    await d.as(u.ceo, `select transition_contract($1, 'mark_ready', null, 'corr-ready')`, [contractId]);
    await d.as(u.ceo, `select record_contract_sent($1, 'sandbox', $2, 'corr-sent')`, [contractId, `sbx_doc_${contractId}`]);
    for (const [role, email] of [["client", "founder@acme.test"], ["atmors", "ceo@atmors.test"]]) {
      await d.as(null, `select ingest_signature_event('sandbox', $1, 'signer.signed', true, $2, $3, $4::jsonb, now(), $5)`, [
        `evt-${role}`, "e".repeat(64), `sbx_doc_${contractId}`, JSON.stringify({ signer_role: role, signer_email: email }), `corr-sign-${role}`,
      ]);
    }
    ({ id: workspaceId } = await one<{ id: string }>(null, `select id from workspaces where contract_id = $1`, [contractId]));
  });

  describe("catalog invariants", () => {
    it("enables RLS on every public table", async () => {
      const rows = await d.as<{ relname: string }>(null, `
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
      expect(rows.map((row) => row.relname)).toEqual([]);
    });

    it("gives anonymous sessions no table access and signed-in sessions read-only access", async () => {
      const anon = await d.as<{ table_name: string; privilege_type: string }>(null, `
        select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'anon' and table_schema = 'public'`);
      expect(anon).toEqual([]);
      const writes = await d.as<{ table_name: string; privilege_type: string }>(null, `
        select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'authenticated' and table_schema = 'public' and privilege_type <> 'SELECT'`);
      expect(writes).toEqual([]);
      // The only column-level write: users editing their own profile name and timezone.
      const columns = await d.as<{ table_name: string; column_name: string }>(null, `
        select table_name, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'UPDATE' order by column_name`);
      expect(columns).toEqual([
        { table_name: "profiles", column_name: "display_name" },
        { table_name: "profiles", column_name: "timezone" },
      ]);
    });

    it("pins every SECURITY DEFINER function to an empty search path", async () => {
      const rows = await d.as<{ proname: string }>(null, `
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prosecdef
          and not coalesce(p.proconfig, '{}') @> array['search_path=""']`);
      expect(rows.map((row) => row.proname)).toEqual([]);
    });

    it("leaves no public-schema function executable by PUBLIC or by anonymous sessions unless intended", async () => {
      const publicExec = await d.as<{ proname: string }>(null, `
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('public', p.oid, 'execute')`);
      expect(publicExec.map((row) => row.proname)).toEqual([]);
      const anon = await d.as<{ proname: string }>(null, `
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
      // Exactly the invitation-token entry points (the token is the credential).
      expect(anon.map((row) => row.proname)).toEqual([
        "book_meeting_with_token",
        "booking_options_with_token",
        "client_knowledge",
        "invitation_view",
        "request_callback_with_token",
        "request_invitation_help",
      ]);
    });
  });

  describe("notifications (AT-031)", () => {
    it("enqueues each business event once, however often it is replayed", async () => {
      const keys = (await d.as<{ idempotency_key: string; template_key: string }>(null, `select idempotency_key, template_key from notifications order by created_at`)).map((row) => row.template_key);
      expect(keys).toEqual(expect.arrayContaining(["contract_ready", "contract_executed", "invoice_issued"]));
      const before = (await one<{ n: number }>(null, `select count(*)::int as n from notifications`)).n;
      // Replaying the signature events and re-running evaluations sends nothing new.
      await d.as(null, `select ingest_signature_event('sandbox', 'evt-client', 'signer.signed', true, $1, $2, '{}'::jsonb, now(), 'replay')`, ["e".repeat(64), `sbx_doc_${contractId}`]);
      await d.as(u.ceo, `select evaluate_contract_activation($1, 'replay')`, [contractId]);
      await d.as(null, `update invoices set status = status where contract_id = $1`, [contractId]);
      expect((await one<{ n: number }>(null, `select count(*)::int as n from notifications`)).n).toBe(before);
    });

    it("claims each message once, retries with backoff, and fails into the exception queue", async () => {
      const claimed = await d.as<{ id: string; attempts: number }>(null, `select * from claim_notifications(100)`);
      expect(claimed.length).toBeGreaterThan(0);
      expect(await d.as(null, `select * from claim_notifications(100)`)).toEqual([]); // nothing double-claimed
      const [first, second] = claimed;
      await d.as(null, `select complete_notification($1, true, 'log', 'msg-1', null)`, [first.id]);
      // Completing again (a retried request) changes nothing.
      const again = await one<{ status: string; provider_message_id: string }>(null, `select * from complete_notification($1, false, 'log', null, 'late error')`, [first.id]);
      expect(again).toMatchObject({ status: "sent", provider_message_id: "msg-1" });

      await d.as(null, `select complete_notification($1, false, 'log', null, 'smtp 451')`, [second.id]);
      const retry = await one<{ status: string; next_attempt_at: string }>(null, `select * from notifications where id = $1`, [second.id]);
      expect(retry.status).toBe("queued");
      expect(new Date(retry.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000);

      await d.as(null, `update notifications set attempts = 5, status = 'sending' where id = $1`, [second.id]);
      await d.as(null, `select complete_notification($1, false, 'log', null, 'mailbox unavailable')`, [second.id]);
      expect((await one<{ status: string }>(null, `select status from notifications where id = $1`, [second.id])).status).toBe("failed");
      expect((await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'notification_failed'`)).n).toBe(1);
      expect(await d.errorOf(u.sales, `select retry_notification($1, 'c')`, [second.id])).toBe("FORBIDDEN");
      await d.as(u.cto, `select retry_notification($1, 'c')`, [second.id]);
      expect((await one<{ status: string }>(null, `select status from notifications where id = $1`, [second.id])).status).toBe("queued");
    });

    it("rate-limits per key and window", async () => {
      const hits = [];
      for (let i = 0; i < 4; i++) hits.push((await one<{ ok: boolean }>(null, `select rate_limit_hit('ip:test', 3, 60) as ok`)).ok);
      expect(hits).toEqual([true, true, true, false]);
    });
  });

  describe("audit completeness (AT-032)", () => {
    it("records actor, time and correlation for proposal, contract, payment, role and activation changes", async () => {
      await d.as(u.ceo, `select record_manual_payment(i.id, i.balance_minor, 'NEFT 42', 'Bank transfer received', 'corr-payment') from invoices i where i.contract_id = $1`, [contractId]);
      const { id: membership } = await one<{ id: string }>(null, `select id from organization_memberships where user_id = $1`, [u.sales]);
      await d.as(u.cto, `select update_membership($1, 'delivery', null, 'Moving to delivery', 'corr-role')`, [membership]);
      await d.as(null, `update workspaces set status = 'blocked' where id = $1`, [workspaceId]);
      await d.as(u.cto, `select override_workspace_activation($1, 'Founder on site; contract on paper', 'corr-override')`, [workspaceId]);

      const expected: [string, string, boolean][] = [
        ["proposal.created", "corr-proposal", false],
        ["proposal.version_sent", "corr-send", false],
        ["proposal.accepted", "corr-accept", false],
        ["contract.generated", "corr-contract", false],
        ["contract.sent", "corr-sent", false],
        ["contract.signature_event", "corr-sign-atmors", false],
        ["invoice.issued", "corr-sign-atmors", false],
        ["payment.manual_recorded", "corr-payment", true],
        ["membership.updated", "corr-role", true],
        ["workspace.activation_overridden", "corr-override", true],
      ];
      for (const [action, correlation, needsReason] of expected) {
        const row = await one<{ actor_type: string; occurred_at: string; reason: string | null; after_summary: Row }>(
          null, `select * from audit_logs where action = $1 and correlation_id = $2`, [action, correlation]);
        expect(row, action).toBeDefined();
        expect(row.occurred_at, action).toBeTruthy();
        expect(["user", "client", "system"]).toContain(row.actor_type);
        if (needsReason) expect(row.reason, action).toBeTruthy();
      }
      // Provider-driven changes carry the provider event as their reference.
      const signed = await one<{ actor_type: string; after_summary: { provider_event_id: string } }>(
        null, `select * from audit_logs where action = 'contract.signature_event' and correlation_id = 'corr-sign-atmors'`);
      expect(signed).toMatchObject({ actor_type: "system", after_summary: { provider_event_id: "evt-atmors" } });
      const accepted = await one<{ actor_type: string; actor_id: string }>(null, `select * from audit_logs where action = 'proposal.accepted'`);
      expect(accepted).toMatchObject({ actor_type: "client", actor_id: u.client });
    });
  });
});
