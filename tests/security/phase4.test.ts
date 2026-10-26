/**
 * Phase 4 against the hosted dev Supabase project: assignment-based least
 * privilege for delivery staff (AT-023), direct-API isolation between clients
 * (AT-024), private storage (AT-022) and the override permission (AT-026).
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

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
  supabaseTestEnv,
  type TypedClient,
} from "../support/supabase-fixture";

const EMAIL = {
  ceo: "p4-ceo+clientos@example.com",
  cto: "p4-cto+clientos@example.com",
  sales: "p4-sales+clientos@example.com",
  delivery: "p4-delivery+clientos@example.com",
  delivery2: "p4-delivery2+clientos@example.com",
  clientA: "p4-client-a+clientos@example.com",
  clientB: "p4-client-b+clientos@example.com",
};
type Who = keyof typeof EMAIL;

const corr = () => randomUUID();
const ANSWERS = {
  business_name: "Acme",
  offer_summary: "B2B analytics",
  target_audience: "Retail merchandisers",
  goals: "Three demos a month",
  channels: ["LinkedIn personal profile"],
  has_brand_guide: false,
  voice: "Direct",
  approver_email: "approver@acme.test",
};

describe.skipIf(!hasSupabaseTestEnv)("Phase 4: onboarding and workspaces", () => {
  const admin = hasSupabaseTestEnv ? adminClient() : (undefined as unknown as TypedClient);
  let c: Record<Who, TypedClient>;
  let users: Record<Who, string>;
  let orgId: string;
  let workspaceA: string;
  let prospectA: string;

  async function rpc(client: TypedClient, fn: string, args: Record<string, unknown>) {
    const { data, error } = await client.rpc(fn as "client_workspace", args as never);
    if (error) throw new Error(`${fn}: ${error.message} ${error.details ?? ""}`);
    return data as unknown;
  }

  /** Accepted proposal → executed agreement for a prospect whose client is `client`. */
  async function executed(prospectId: string, client: TypedClient, email: string) {
    const proposal = (await rpc(c.sales, "create_proposal", { p_prospect_id: prospectId, p_title: `P4 ${randomUUID().slice(0, 6)}`, p_currency: "INR", p_correlation_id: corr() })) as {
      id: string; current_version_id: string; title: string;
    };
    const v = proposal.current_version_id;
    await rpc(c.sales, "save_proposal_draft", {
      p_version_id: v, p_title: proposal.title, p_currency: "INR",
      p_valid_until: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
      p_content: { summary: "S", scope: "S" },
      p_payment_schedule: [{ label: "Deposit", basis: "percent", percent_bps: 10000, due: "on_signing" }],
      p_line_items: [{ title: "Work", quantity: 1, unit_amount_minor: 50000, tax_rate_bps: 0 }],
      p_correlation_id: corr(),
    });
    await rpc(c.sales, "submit_proposal_version", { p_version_id: v, p_correlation_id: corr() });
    await rpc(c.sales, "send_proposal_version", { p_version_id: v, p_correlation_id: corr() });
    const { tokenHash } = generateInvitationToken();
    await rpc(c.sales, "create_invitation", { p_prospect_id: prospectId, p_proposal_id: proposal.id, p_token_hash: tokenHash, p_expires_in_days: 14, p_correlation_id: corr() });
    await rpc(client, "redeem_invitation", { p_token_hash: tokenHash, p_correlation_id: corr() });
    const view = (await rpc(client, "client_proposal_view", { p_proposal_id: proposal.id })) as { version: { content_hash: string } };
    await rpc(client, "accept_proposal", { p_proposal_id: proposal.id, p_version_id: v, p_content_hash: view.version.content_hash, p_correlation_id: corr() });
    const contract = (await rpc(c.ceo, "generate_contract", {
      p_proposal_id: proposal.id,
      p_template_id: (await c.ceo.from("contract_templates").select("id").eq("organization_id", orgId).eq("active", true).single()).data!.id,
      p_legal: { client_legal_name: "Fixture Pvt Ltd", client_address: "1 Test Road, Pune", signer_name: "Signer", signer_email: email },
      p_countersigner_user_id: users.ceo,
      p_correlation_id: corr(),
    })) as { id: string };
    await rpc(c.ceo, "transition_contract", { p_contract_id: contract.id, p_action: "mark_ready", p_correlation_id: corr() });
    await rpc(c.ceo, "record_contract_sent", { p_contract_id: contract.id, p_provider: "sandbox", p_provider_document_id: `sbx_doc_${contract.id}`, p_correlation_id: corr() });
    for (const [role, signer] of [["client", email], ["atmors", EMAIL.ceo]]) {
      await rpc(admin, "ingest_signature_event", {
        p_provider: "sandbox", p_provider_event_id: `p4-${randomUUID()}`, p_event_type: "signer.signed", p_signature_verified: true,
        p_payload_hash: "a".repeat(64), p_provider_document_id: `sbx_doc_${contract.id}`,
        p_data: { signer_role: role, signer_email: signer }, p_occurred_at: new Date().toISOString(), p_correlation_id: corr(),
      });
    }
    const { data: workspace } = await admin.from("workspaces").select("id").eq("contract_id", contract.id).single();
    return workspace!.id;
  }

  beforeAll(async () => {
    users = {} as Record<Who, string>;
    for (const who of Object.keys(EMAIL) as Who[]) users[who] = await ensureUser(admin, EMAIL[who], `P4 ${who}`);
    orgId = await ensureOrganization(admin, "p4-fixture", "Phase 4 Fixture Org");
    for (const [who, role] of [["ceo", "ceo"], ["cto", "cto_coo"], ["sales", "sales"], ["delivery", "delivery"], ["delivery2", "delivery"]] as const) {
      await ensureMembership(admin, orgId, users[who], role);
    }
    c = {} as Record<Who, TypedClient>;
    for (const who of Object.keys(EMAIL) as Who[]) c[who] = await signedInClient(EMAIL[who]);
    await rpc(c.ceo, "configure_integration_account", { p_organization_id: orgId, p_kind: "esign", p_provider: "sandbox", p_account_id: "sandbox", p_active: true, p_correlation_id: corr() });

    // Fresh prospects each run so onboarding starts from scratch.
    const run = randomUUID().slice(0, 6);
    const emailA = EMAIL.clientA;
    await admin.from("prospects").update({ email: null }).eq("organization_id", orgId).eq("normalized_email", emailA);
    await admin.from("client_access").update({ status: "revoked" }).eq("user_id", users.clientA);
    prospectA = await ensureProspect(admin, orgId, users.sales, emailA, `Asha P4 ${run}`);
    workspaceA = await executed(prospectA, c.clientA, emailA);
    await rpc(c.cto, "set_workspace_member", { p_workspace_id: workspaceA, p_user_id: users.delivery, p_role: "lead", p_correlation_id: corr() });
    await rpc(c.cto, "save_task", { p_workspace_id: workspaceA, p_task_id: null, p_fields: { title: "Internal plan", internal_notes: "SECRET-MARGIN-NOTE" }, p_correlation_id: corr() });
  });

  it("AT-023: delivery staff see only assigned workspaces and never commercial or financial records", async () => {
    const assigned = await c.delivery.from("workspaces").select("id").eq("id", workspaceA);
    expect(assigned.data).toHaveLength(1);
    const unassigned = await c.delivery2.from("workspaces").select("id").eq("id", workspaceA);
    expect(unassigned.data).toHaveLength(0);
    for (const table of ["tasks", "milestones", "workspace_updates", "workspace_members"] as const) {
      const rows = await c.delivery2.from(table).select("*").eq("workspace_id", workspaceA);
      expect(rows.data ?? [], table).toHaveLength(0);
    }
    const tasks = await c.delivery.from("tasks").select("title").eq("workspace_id", workspaceA);
    expect(tasks.data?.map((task) => task.title)).toContain("Internal plan");

    for (const client of [c.delivery, c.delivery2]) {
      expect((await client.from("prospects").select("id, notes").eq("id", prospectA)).data ?? []).toHaveLength(0);
      expect((await client.from("invoices").select("id").eq("prospect_id", prospectA)).data ?? []).toHaveLength(0);
      expect((await client.from("contracts").select("id").eq("prospect_id", prospectA)).data ?? []).toHaveLength(0);
      expect((await client.from("proposals").select("id").eq("prospect_id", prospectA)).data ?? []).toHaveLength(0);
    }
  });

  it("AT-023: delivery sees onboarding answers only once approved", async () => {
    await rpc(c.clientA, "client_submit_onboarding", { p_answers: ANSWERS, p_correlation_id: corr() });
    const { data: onboarding } = await c.cto.from("onboardings").select("id, current_submission_id").eq("prospect_id", prospectA).single();
    const before = await c.delivery.from("onboarding_answers").select("question_key").eq("submission_id", onboarding!.current_submission_id!);
    expect(before.data ?? []).toHaveLength(0);
    await rpc(c.cto, "review_onboarding", {
      p_onboarding_id: onboarding!.id, p_submission_id: onboarding!.current_submission_id, p_decision: "approved", p_reasons: [], p_correlation_id: corr(),
    });
    const after = await c.delivery.from("onboarding_answers").select("question_key").eq("submission_id", onboarding!.current_submission_id!);
    expect(after.data?.length).toBeGreaterThan(0);
    expect((await c.delivery2.from("onboarding_answers").select("question_key").eq("submission_id", onboarding!.current_submission_id!)).data ?? []).toHaveLength(0);
  });

  it("AT-024: clients never read these tables directly, and only see their own projections", async () => {
    for (const table of ["onboardings", "onboarding_answers", "client_assets", "access_grants", "workspaces", "tasks", "questionnaire_templates"] as const) {
      expect((await c.clientA.from(table).select("*").limit(1)).data ?? [], table).toHaveLength(0);
      expect((await anonClient().from(table).select("*").limit(1)).data ?? [], table).toHaveLength(0);
    }
    const own = (await rpc(c.clientA, "client_workspace", {})) as { id: string } | null;
    expect(own?.id).toBe(workspaceA);
    expect(JSON.stringify(own)).not.toContain("SECRET-MARGIN-NOTE");
    const other = (await rpc(c.clientB, "client_workspace", {})) as { id: string } | null;
    expect(other?.id).not.toBe(workspaceA);
    const insert = await c.clientA.from("onboarding_answers").insert({ organization_id: orgId, submission_id: randomUUID(), question_key: "x", answer_json: "y" });
    expect(insert.error).not.toBeNull();
  });

  it("AT-022: assets live in a private bucket reachable only through authorized signed URLs", async () => {
    const registered = (await rpc(c.clientA, "client_register_asset", {
      p_filename: "brief.txt", p_content_type: "text/plain", p_size_bytes: 5, p_checksum: "c".repeat(64), p_correlation_id: corr(),
    })) as { asset_id: string; storage_key: string };
    expect((await c.clientA.rpc("mark_asset_stored", { p_asset_id: registered.asset_id, p_ok: true })).error).not.toBeNull();
    const upload = await admin.storage.from("client-assets").upload(registered.storage_key, new Blob(["hello"], { type: "text/plain" }), { contentType: "text/plain" });
    expect(upload.error).toBeNull();
    await rpc(admin, "mark_asset_stored", { p_asset_id: registered.asset_id, p_ok: true });

    const publicUrl = `${supabaseTestEnv.url}/storage/v1/object/public/client-assets/${registered.storage_key}`;
    expect((await fetch(publicUrl)).ok).toBe(false);
    expect((await c.clientA.storage.from("client-assets").download(registered.storage_key)).error).not.toBeNull();
    expect((await anonClient().storage.from("client-assets").download(registered.storage_key)).error).not.toBeNull();
    expect((await c.clientA.storage.from("client-assets").upload(`${orgId}/x/evil.txt`, new Blob(["x"]))).error).not.toBeNull();

    expect((await c.clientB.rpc("asset_download_target", { p_asset_id: registered.asset_id, p_correlation_id: corr() })).error?.message).toBe("NOT_FOUND");
    expect((await c.delivery2.rpc("asset_download_target", { p_asset_id: registered.asset_id, p_correlation_id: corr() })).error?.message).toBe("NOT_FOUND");
    const target = (await rpc(c.clientA, "asset_download_target", { p_asset_id: registered.asset_id, p_correlation_id: corr() })) as { storage_key: string };
    const signed = await admin.storage.from("client-assets").createSignedUrl(target.storage_key, 60);
    expect(await (await fetch(signed.data!.signedUrl)).text()).toBe("hello");
  });

  it("AT-026: only override holders activate manually, and it stays marked", async () => {
    const prospectB = await ensureProspect(admin, orgId, users.sales, `p4-ov-${randomUUID().slice(0, 6)}+clientos@example.com`, "Override P4");
    // The override test does not need a client: make a workspace row directly as fixture.
    const { data: contract } = await admin.from("contracts").select("id").eq("organization_id", orgId).limit(1).single();
    const { data: workspace, error } = await admin
      .from("workspaces")
      .insert({ organization_id: orgId, prospect_id: prospectB, contract_id: contract!.id, client_name: "Override P4" })
      .select("id")
      .single();
    expect(error).toBeNull();
    for (const who of ["ceo", "sales", "delivery"] as Who[]) {
      const result = await c[who].rpc("override_workspace_activation", { p_workspace_id: workspace!.id, p_reason: "test", p_correlation_id: corr() });
      expect(result.error?.message, who).toBe("FORBIDDEN");
    }
    const ok = await c.cto.rpc("override_workspace_activation", { p_workspace_id: workspace!.id, p_reason: "Signed paper agreement on file", p_correlation_id: corr() });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ status: "active", override_active: true, override_reason: "Signed paper agreement on file" });
  });
});
