/**
 * Phase 4 SQL rules on PGlite: onboarding revisions and review (AT-021),
 * asset registration and download authorization (AT-022), assignment-based
 * least privilege (AT-023), activation from authoritative records (AT-025)
 * and manual override (AT-026). RLS is covered in tests/security/phase4.test.ts.
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { migratedDatabase } from "../support/pglite-db";

type Db = Awaited<ReturnType<typeof migratedDatabase>>;
type Row = Record<string, unknown>;

const CONTENT = JSON.stringify({ summary: "Grow pipeline", scope: "LinkedIn content" });
const SCHEDULE = JSON.stringify([
  { label: "Deposit", basis: "percent", percent_bps: 5000, due: "on_signing" },
  { label: "Balance", basis: "percent", percent_bps: 5000, due: "on_milestone", milestone: "Month 1" },
]);
const LINES = JSON.stringify([{ title: "Content", quantity: 1, unit_amount_minor: 100000, tax_rate_bps: 1800 }]);
const hash = (label: string) => createHash("sha256").update(label).digest("hex");

const ANSWERS = {
  business_name: "Acme",
  website: "https://acme.test",
  offer_summary: "B2B analytics for retailers",
  target_audience: "Heads of merchandising at mid-size retailers in India",
  goals: "Three qualified demos a month",
  channels: ["LinkedIn personal profile"],
  has_brand_guide: false,
  brand_guide_notes: "should be dropped: the follow-up is hidden",
  voice: "Direct and practical",
  approver_email: "founder@acme.test",
  injected_field: "should be dropped",
};

describe("Phase 4 SQL rules (PGlite)", () => {
  let d: Db;
  const u: Record<string, string> = {};
  let org: string;
  let template: string;
  let counter = 0;

  async function one<T extends Row = Row>(user: string | null, sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await d.as<T>(user, sql, params);
    return row;
  }

  async function newProspect(clientKey: string, email: string) {
    ({ id: u[clientKey] } = await one<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [email]));
    const { id } = await one<{ id: string }>(
      u.sales,
      `select id from create_prospect($1, $2, 'Client', 'Acme', $3, 'email', null, null, null, null, null, 'c')`,
      [org, u.sales, email],
    );
    return id;
  }

  /** Accepted proposal → executed agreement with the given activation policy. */
  async function executed(prospect: string, client: string, email: string, policy: Row | null = null) {
    const proposal = await one<{ id: string; current_version_id: string }>(u.sales, `select * from create_proposal($1, 'Retainer', 'INR', 'c')`, [prospect]);
    const v = proposal.current_version_id;
    await d.as(u.sales, `select save_proposal_draft($1, 'Retainer', 'INR', current_date + 10, $2::jsonb, $3::jsonb, $4::jsonb, '{}', false, false, 'c')`, [
      v, CONTENT, SCHEDULE, LINES,
    ]);
    await d.as(u.sales, `select submit_proposal_version($1, 'c')`, [v]);
    await d.as(u.sales, `select send_proposal_version($1, 'c')`, [v]);
    const token = hash(`token-${++counter}`);
    await d.as(u.sales, `select create_invitation($1, $2, $3, 14, 'c')`, [prospect, proposal.id, token]);
    await d.as(u[client], `select redeem_invitation($1, 'c')`, [token]);
    const { h } = await one<{ h: string }>(null, `select content_hash as h from proposal_versions where id = $1`, [v]);
    await d.as(u[client], `select accept_proposal($1, $2, $3, 'c')`, [proposal.id, v, h]);
    const legal = JSON.stringify({ client_legal_name: "Acme Pvt Ltd", client_address: "1 MG Road, Pune", signer_name: "Founder", signer_email: email });
    const contract = await one<{ id: string }>(u.ceo, `select * from generate_contract($1, $2, $3::jsonb, $4, $5::jsonb, 'c')`, [
      proposal.id, template, legal, u.ceo, policy ? JSON.stringify(policy) : null,
    ]);
    await d.as(u.ceo, `select transition_contract($1, 'mark_ready', null, 'c')`, [contract.id]);
    await d.as(u.ceo, `select record_contract_sent($1, 'sandbox', $2, 'c')`, [contract.id, `sbx_doc_${contract.id}`]);
    for (const [role, signer] of [["client", email], ["atmors", "ceo@atmors.test"]]) {
      await d.as(null, `select ingest_signature_event('sandbox', $1, 'signer.signed', true, $2, $3, $4::jsonb, now(), 'c')`, [
        `sig-${role}-${contract.id}`, "e".repeat(64), `sbx_doc_${contract.id}`, JSON.stringify({ signer_role: role, signer_email: signer }),
      ]);
    }
    const workspace = await one<{ id: string; status: string; blocked_reasons: string[] }>(null, `select * from workspaces where contract_id = $1`, [contract.id]);
    return { contractId: contract.id, workspace };
  }

  async function payDeposit(contractId: string, client: string) {
    const { id: invoiceId } = await one<{ id: string }>(
      null,
      `select i.id from invoices i join payment_schedule_items s on s.id = i.schedule_item_id where i.contract_id = $1 and s.position = 0`,
      [contractId],
    );
    const { r } = await one<{ r: { payment_id: string; amount_minor: number } }>(u[client], `select client_start_payment($1, 'sandbox', null, $2, 'c') as r`, [
      invoiceId, `pay-key-${++counter}-xxxxxxxx`,
    ]);
    const order = `sbx_order_${r.payment_id}`;
    await d.as(null, `select attach_payment_order($1, $2)`, [r.payment_id, order]);
    await d.as(null, `select ingest_payment_event('sandbox', $1, 'payment.succeeded', true, $2, $3::jsonb, 'c')`, [
      `pay-${r.payment_id}`, "f".repeat(64),
      JSON.stringify({ account_id: "acc_sandbox", provider_order_id: order, provider_payment_id: `p_${r.payment_id}`, amount_minor: r.amount_minor, currency: "INR" }),
    ]);
  }

  const workspaceRow = (id: string) =>
    one<{ status: string; blocked_reasons: string[]; override_active: boolean; delivery_status: string; kickoff_blockers: string[] }>(
      null, `select * from workspaces where id = $1`, [id]);

  beforeAll(async () => {
    d = await migratedDatabase();
    for (const [name, email] of Object.entries({
      ceo: "ceo@atmors.test",
      cto: "cto@atmors.test",
      sales: "sales@atmors.test",
      delivery: "delivery@atmors.test",
      delivery2: "delivery2@atmors.test",
      stranger: "stranger@else.test",
    })) {
      ({ id: u[name] } = await one<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [email]));
    }
    ({ id: org } = await one<{ id: string }>(null, `insert into organizations (name, slug) values ('Atmors', 'atmors') returning id`));
    await d.as(
      null,
      `insert into organization_memberships (organization_id, user_id, role) values
       ($1, $2, 'ceo'), ($1, $3, 'cto_coo'), ($1, $4, 'sales'), ($1, $5, 'delivery'), ($1, $6, 'delivery')`,
      [org, u.ceo, u.cto, u.sales, u.delivery, u.delivery2],
    );
    ({ id: template } = await one<{ id: string }>(null, `select id from contract_templates where organization_id = $1 and active`, [org]));
    await d.as(u.ceo, `select configure_integration_account($1, 'esign', 'sandbox', 'sandbox', true, 'c')`, [org]);
    await d.as(u.ceo, `select configure_integration_account($1, 'payments', 'sandbox', 'acc_sandbox', true, 'c')`, [org]);
  });

  describe("onboarding (AT-021)", () => {
    let prospect: string;
    let workspaceId: string;

    beforeAll(async () => {
      prospect = await newProspect("client", "founder@acme.test");
      ({ workspace: { id: workspaceId } } = await executed(prospect, "client", "founder@acme.test"));
    });

    it("executing the agreement creates a blocked workspace and starts onboarding", async () => {
      const workspace = await workspaceRow(workspaceId);
      expect(workspace).toMatchObject({ status: "blocked", blocked_reasons: ["payment_item_unpaid:0"] });
      const { status } = await one<{ status: string }>(null, `select status from onboardings where prospect_id = $1`, [prospect]);
      expect(status).toBe("not_started");
    });

    it("drafts keep only known, visible answers", async () => {
      const { r } = await one<{ r: { status: string; draft_answers: Row } }>(u.client, `select client_save_onboarding_draft($1::jsonb, 'c') as r`, [
        JSON.stringify(ANSWERS),
      ]);
      expect(r.status).toBe("in_progress");
      expect(r.draft_answers).not.toHaveProperty("injected_field");
      expect(r.draft_answers).not.toHaveProperty("brand_guide_notes");
      expect(await d.errorOf(u.client, `select client_save_onboarding_draft($1::jsonb, 'c')`, [JSON.stringify({ website: "not a url" })])).toBe(
        "VALIDATION_FAILED",
      );
      expect(await d.errorOf(u.client, `select client_save_onboarding_draft($1::jsonb, 'c')`, [JSON.stringify({ channels: ["Fax"] })])).toBe(
        "VALIDATION_FAILED",
      );
    });

    it("preserves every revision; review loops on the latest one", async () => {
      expect(await d.errorOf(u.client, `select client_submit_onboarding($1::jsonb, 'c')`, [JSON.stringify({ business_name: "Acme" })])).toBe(
        "VALIDATION_FAILED",
      );
      await d.as(u.client, `select client_submit_onboarding($1::jsonb, 'c')`, [JSON.stringify(ANSWERS)]);
      const onboarding = await one<{ id: string; status: string; current_submission_id: string }>(null, `select * from onboardings where prospect_id = $1`, [prospect]);
      expect(onboarding.status).toBe("submitted");
      const first = onboarding.current_submission_id;
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'onboarding_review' and prospect_id = $1`, [prospect]);
      expect(n).toBe(1);

      expect(await d.errorOf(u.delivery, `select review_onboarding($1, $2, 'approved', '[]', 'c')`, [onboarding.id, first])).toBe("FORBIDDEN");
      expect(await d.errorOf(u.cto, `select review_onboarding($1, $2, 'needs_information', '[]', 'c')`, [onboarding.id, first])).toBe(
        "VALIDATION_FAILED",
      );
      await d.as(u.cto, `select review_onboarding($1, $2, 'needs_information', $3::jsonb, 'c')`, [
        onboarding.id, first, JSON.stringify([{ question_key: "target_audience", message: "Which regions first?" }]),
      ]);
      const { r: view } = await one<{ r: { status: string; info_requests: { message: string }[] } }>(u.client, `select client_onboarding() as r`);
      expect(view.status).toBe("needs_information");
      expect(view.info_requests[0].message).toBe("Which regions first?");

      await d.as(u.client, `select client_submit_onboarding($1::jsonb, 'c')`, [
        JSON.stringify({ ...ANSWERS, target_audience: "Mumbai and Bengaluru first, then national" }),
      ]);
      const after = await one<{ status: string; current_submission_id: string }>(null, `select * from onboardings where id = $1`, [onboarding.id]);
      expect(after.status).toBe("resubmitted");
      expect(after.current_submission_id).not.toBe(first);

      // The original revision and its answers are untouched (AT-021).
      const original = await one<{ answer: string }>(
        null, `select answer_json #>> '{}' as answer from onboarding_answers where submission_id = $1 and question_key = 'target_audience'`, [first]);
      expect(original.answer).toBe(ANSWERS.target_audience);
      expect(await d.errorOf(null, `update onboarding_answers set answer_json = '"AI rewrite"'::jsonb`)).toBe("APPEND_ONLY");
      expect(await d.errorOf(null, `delete from onboarding_submissions`)).toBe("APPEND_ONLY");
      const { sources } = await one<{ sources: string[] }>(null, `select array_agg(distinct answer_source) as sources from onboarding_answers`);
      expect(sources).toEqual(["client"]);

      expect(await d.errorOf(u.cto, `select review_onboarding($1, $2, 'approved', '[]', 'c')`, [onboarding.id, first])).toBe("VERSION_STALE");
      await d.as(u.cto, `select review_onboarding($1, $2, 'approved', '[]', 'c')`, [onboarding.id, after.current_submission_id]);
      expect(await d.errorOf(u.client, `select client_submit_onboarding($1::jsonb, 'c')`, [JSON.stringify(ANSWERS)])).toBe("INVALID_STATE_TRANSITION");
    });

    it("rejects questionnaires whose follow-ups point forwards", async () => {
      const bad = JSON.stringify([
        { key: "a", label: "A", type: "text", required: true, show_if: { question: "b", equals: true } },
        { key: "b", label: "B", type: "boolean", required: true },
      ]);
      expect(await d.errorOf(u.cto, `select save_questionnaire_template($1, 'client-onboarding', 'Bad', $2::jsonb, false, 'c')`, [org, bad])).toBe(
        "VALIDATION_FAILED",
      );
      expect(await d.errorOf(u.sales, `select save_questionnaire_template($1, 'client-onboarding', 'X', '[]'::jsonb, false, 'c')`, [org])).toBe("FORBIDDEN");
    });
  });

  describe("activation, kickoff and override (AT-025, AT-026)", () => {
    it("activates only when the agreement's configured conditions are met by authoritative records", async () => {
      const prospect = await newProspect("client2", "two@acme.test");
      const policy = {
        required_contract_state: "executed",
        required_payment_items: [0],
        required_onboarding_state: "approved",
        required_manual_review: false,
      };
      const { contractId, workspace } = await executed(prospect, "client2", "two@acme.test", policy);
      expect(workspace.blocked_reasons.sort()).toEqual(["onboarding_not_approved", "payment_item_unpaid:0"]);

      await payDeposit(contractId, "client2");
      expect(await workspaceRow(workspace.id)).toMatchObject({ status: "blocked", blocked_reasons: ["onboarding_not_approved"] });
      const { r: clientView } = await one<{ r: { status: string } }>(u.client2, `select client_workspace() as r`);
      expect(clientView.status).toBe("setting_up"); // no internal reasons for the client

      await d.as(u.client2, `select client_submit_onboarding($1::jsonb, 'c')`, [JSON.stringify(ANSWERS)]);
      const o = await one<{ id: string; current_submission_id: string }>(null, `select * from onboardings where prospect_id = $1`, [prospect]);
      await d.as(u.cto, `select review_onboarding($1, $2, 'approved', '[]', 'c')`, [o.id, o.current_submission_id]);
      const active = await workspaceRow(workspace.id);
      expect(active).toMatchObject({ status: "active", override_active: false, delivery_status: "not_ready", kickoff_blockers: ["no_delivery_lead"] });

      await d.as(u.cto, `select set_workspace_member($1, $2, 'lead', 'c')`, [workspace.id, u.delivery]);
      expect((await workspaceRow(workspace.id)).delivery_status).toBe("kickoff_ready");
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from ops_tasks where kind = 'schedule_kickoff' and related_id = $1`, [workspace.id]);
      expect(n).toBe(1);
      const { r: ready } = await one<{ r: { status: string; updates: { body: string }[] } }>(u.client2, `select client_workspace() as r`);
      expect(ready.status).toBe("active");
      expect(ready.updates[0].body).toContain("Your workspace is active");
    });

    it("lets only override holders activate manually, with a reason, visibly", async () => {
      const prospect = await newProspect("client3", "three@acme.test");
      const { workspace } = await executed(prospect, "client3", "three@acme.test");
      for (const user of [u.ceo, u.delivery, u.client3]) {
        expect(await d.errorOf(user, `select override_workspace_activation($1, 'Paid by bank transfer', 'c')`, [workspace.id])).toBe("FORBIDDEN");
      }
      expect(await d.errorOf(u.cto, `select override_workspace_activation($1, '', 'c')`, [workspace.id])).toBe("VALIDATION_FAILED");
      await d.as(u.cto, `select override_workspace_activation($1, 'Founder confirmed bank transfer; receipt pending', 'override-corr')`, [workspace.id]);
      const row = await workspaceRow(workspace.id);
      expect(row).toMatchObject({ status: "active", override_active: true });
      const audit = await one<{ reason: string; actor_id: string }>(
        null, `select * from audit_logs where action = 'workspace.activation_overridden' and correlation_id = 'override-corr'`);
      expect(audit).toMatchObject({ reason: "Founder confirmed bank transfer; receipt pending", actor_id: u.cto });
      // The override does not fabricate payment evidence.
      const { paid } = await one<{ paid: number }>(null, `select count(*)::int as paid from payments p join invoices i on i.id = p.invoice_id where i.prospect_id = $1`, [prospect]);
      expect(paid).toBe(0);
      expect(await d.errorOf(u.cto, `select transition_workspace($1, 'eligible', 'x reason', 'c')`, [workspace.id])).toBe("INVALID_STATE_TRANSITION");
    });
  });

  describe("delivery least privilege (AT-023)", () => {
    let workspaceId: string;
    let taskId: string;
    let blockedTaskId: string;

    beforeAll(async () => {
      const prospect = await newProspect("client4", "four@acme.test");
      ({ workspace: { id: workspaceId } } = await executed(prospect, "client4", "four@acme.test"));
      await d.as(u.cto, `select set_workspace_member($1, $2, 'member', 'c')`, [workspaceId, u.delivery]);
      ({ id: taskId } = await one<{ id: string }>(u.cto, `select * from save_task($1, null, $2::jsonb, 'c')`, [
        workspaceId, JSON.stringify({ title: "Draft content calendar", owner_user_id: u.delivery, client_visible: true, internal_notes: "margin is thin" }),
      ]));
      ({ id: blockedTaskId } = await one<{ id: string }>(u.cto, `select * from save_task($1, null, $2::jsonb, 'c')`, [
        workspaceId, JSON.stringify({ title: "Publish first post", owner_user_id: u.delivery, dependency_id: taskId }),
      ]));
      await d.as(u.cto, `select post_workspace_update($1, 'internal', 'Client is price-sensitive', 'c')`, [workspaceId]);
    });

    it("scopes delivery staff to assigned workspaces and their own tasks", async () => {
      const can = async (user: string, fn: string) =>
        (await one<{ ok: boolean }>(user, `select private.${fn}($1) as ok`, [workspaceId])).ok;
      expect(await can(u.delivery, "can_read_workspace")).toBe(true);
      expect(await can(u.delivery2, "can_read_workspace")).toBe(false);
      expect(await can(u.delivery, "can_manage_workspace")).toBe(false);

      expect(await d.errorOf(u.delivery2, `select update_task_status($1, 'in_progress', null, 'c')`, [taskId])).toBe("FORBIDDEN");
      expect(await d.errorOf(u.delivery, `select save_task($1, null, '{"title": "Sneaky"}'::jsonb, 'c')`, [workspaceId])).toBe("FORBIDDEN");
      expect(await d.errorOf(u.delivery, `select post_workspace_update($1, 'client', 'Hi', 'c')`, [workspaceId])).toBe("FORBIDDEN");
      expect(await d.errorOf(u.delivery, `select post_workspace_update($1, 'internal', 'Draft started', 'c')`, [workspaceId])).toBeNull();

      expect(await d.errorOf(u.delivery, `select update_task_status($1, 'done', null, 'c')`, [blockedTaskId])).toBe("INVALID_STATE_TRANSITION");
      await d.as(u.delivery, `select update_task_status($1, 'done', 'Calendar shared in Drive', 'c')`, [taskId]);
      expect(await d.errorOf(u.delivery, `select update_task_status($1, 'done', null, 'c')`, [blockedTaskId])).toBeNull();
    });

    it("hides onboarding material from delivery until it is approved, and commercial records always", async () => {
      const { prospect_id } = await one<{ prospect_id: string }>(null, `select prospect_id from workspaces where id = $1`, [workspaceId]);
      expect((await one<{ ok: boolean }>(u.delivery, `select private.can_read_onboarding($1) as ok`, [prospect_id])).ok).toBe(false);
      expect((await one<{ ok: boolean }>(u.delivery, `select private.can_read_prospect($1) as ok`, [prospect_id])).ok).toBe(false);
      expect((await one<{ ok: boolean }>(u.delivery, `select private.has_permission($1, 'finance.read') as ok`, [org])).ok).toBe(false);
    });

    it("keeps internal notes and tasks out of the client's view", async () => {
      const { r } = await one<{ r: Row }>(u.client4, `select client_workspace() as r`);
      const text = JSON.stringify(r);
      expect(text).toContain("Draft content calendar");
      expect(text).toContain("Done: Draft content calendar");
      expect(text).not.toContain("Publish first post");
      expect(text).not.toContain("margin is thin");
      expect(text).not.toContain("price-sensitive");
      expect(text).not.toContain("Draft started");
    });
  });

  describe("assets and access grants (AT-022)", () => {
    let prospect: string;

    beforeAll(async () => {
      prospect = await newProspect("client5", "five@acme.test");
      await executed(prospect, "client5", "five@acme.test");
    });

    it("validates uploads, never uses the filename as the storage path, and authorizes downloads", async () => {
      const register = (name: string, type: string, size: number) =>
        d.errorOf(u.client5, `select client_register_asset($1, $2, $3, $4, 'c')`, [name, type, size, "a".repeat(64)]);
      expect(await register("logo.svg", "image/svg+xml", 100)).toBe("VALIDATION_FAILED");
      expect(await register("big.pdf", "application/pdf", 11 * 1024 * 1024)).toBe("VALIDATION_FAILED");
      expect(await d.errorOf(u.stranger, `select client_register_asset('a.pdf', 'application/pdf', 10, $1, 'c')`, ["a".repeat(64)])).toBe("NOT_FOUND");

      const { r } = await one<{ r: { asset_id: string; storage_key: string } }>(
        u.client5, `select client_register_asset('../../etc/passwd.pdf', 'application/pdf', 1234, $1, 'c') as r`, ["b".repeat(64)]);
      expect(r.storage_key).not.toContain("passwd");
      expect(r.storage_key).not.toContain("..");
      // Not downloadable until the bytes are stored and checked.
      expect(await d.errorOf(u.client5, `select asset_download_target($1, 'c')`, [r.asset_id])).toBe("NOT_FOUND");
      await d.as(null, `select mark_asset_stored($1, true)`, [r.asset_id]);
      expect(await d.errorOf(u.stranger, `select asset_download_target($1, 'c')`, [r.asset_id])).toBe("NOT_FOUND");
      expect(await d.errorOf(u.delivery, `select asset_download_target($1, 'c')`, [r.asset_id])).toBe("NOT_FOUND");
      await d.as(u.client5, `select asset_download_target($1, 'download-corr')`, [r.asset_id]);
      await d.as(u.cto, `select asset_download_target($1, 'download-corr')`, [r.asset_id]);
      const { n } = await one<{ n: number }>(null, `select count(*)::int as n from audit_logs where action = 'asset.downloaded' and correlation_id = 'download-corr'`);
      expect(n).toBe(2);
    });

    it("tracks access grants without ever accepting passwords", async () => {
      expect(
        await d.errorOf(u.cto, `select request_access_grant($1, 'LinkedIn', 'Page admin', 'Our password: hunter2', null, 'c')`, [prospect]),
      ).toBe("VALIDATION_FAILED");
      const grant = await one<{ id: string }>(u.cto, `select * from request_access_grant($1, 'LinkedIn', 'Company page admin', 'Add us as admin from Page settings', null, 'c')`, [prospect]);
      expect(await d.errorOf(u.client5, `select client_confirm_access_grant($1, 'pwd= abc', 'c')`, [grant.id])).toBe("VALIDATION_FAILED");
      await d.as(u.client5, `select client_confirm_access_grant($1, 'Added you as admin', 'c')`, [grant.id]);
      expect(await d.errorOf(u.cto, `select update_access_grant($1, 'requested', null, 'c')`, [grant.id])).toBe("INVALID_STATE_TRANSITION");
      await d.as(u.cto, `select update_access_grant($1, 'verified', null, 'c')`, [grant.id]);
      await d.as(u.cto, `select update_access_grant($1, 'revoked', null, 'c')`, [grant.id]);
      const { status } = await one<{ status: string }>(null, `select status from access_grants where id = $1`, [grant.id]);
      expect(status).toBe("revoked");
    });
  });
});
