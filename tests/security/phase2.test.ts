/**
 * Phase 2 acceptance tests AT-001–AT-009 plus least-privilege checks, run
 * against the hosted dev Supabase project with dedicated fixtures. Each run
 * creates fresh proposals on fixed fixture prospects.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { generateInvitationToken } from "@/modules/crm/invitation-token";
import { fromPostgrestError } from "@/server/errors";

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
  ceo: "p2-ceo+clientos@example.com",
  sales: "p2-sales+clientos@example.com",
  cto: "p2-cto+clientos@example.com",
  delivery: "p2-delivery+clientos@example.com",
  clientA: "p2-client-a+clientos@example.com",
  clientB: "p2-client-b+clientos@example.com",
};

type Clients = Record<keyof typeof EMAIL, TypedClient>;

const CONTENT = {
  summary: "Grow qualified pipeline",
  scope: "LinkedIn content and outreach",
  deliverables: ["12 posts per month"],
  timeline: "Three months",
  dependencies: [],
  assumptions: [],
  exclusions: ["Paid ads"],
  terms: "Standard terms",
};
const SCHEDULE = [
  { label: "Deposit", basis: "percent", percent_bps: 5000, due: "on_signing" },
  { label: "Balance", basis: "percent", percent_bps: 5000, due: "on_milestone", milestone: "Month 1" },
];

function inDays(days: number) {
  return new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
}

const corr = () => randomUUID();

describe.skipIf(!hasSupabaseTestEnv)("Phase 2: invitations, proposals and proof", () => {
  const admin = hasSupabaseTestEnv ? adminClient() : (undefined as unknown as TypedClient);
  let c: Clients;
  let orgId: string;
  let users: Record<keyof typeof EMAIL, string>;
  let prospectA: string;
  let prospectB: string;

  /** Create, fill, submit and (optionally) approve + send a proposal for a prospect. */
  async function makeProposal(
    author: TypedClient,
    prospectId: string,
    options: { discount?: number; send?: boolean; approver?: TypedClient; proofIds?: string[] } = {},
  ) {
    const { data: proposal, error } = await author.rpc("create_proposal", {
      p_prospect_id: prospectId,
      p_title: `Fixture ${randomUUID().slice(0, 8)}`,
      p_currency: "INR",
      p_correlation_id: corr(),
    });
    if (error) throw error;
    const versionId = proposal.current_version_id!;
    const save = await author.rpc("save_proposal_draft", {
      p_version_id: versionId,
      p_title: proposal.title,
      p_currency: "INR",
      p_valid_until: inDays(10),
      p_content: CONTENT,
      p_payment_schedule: SCHEDULE,
      p_line_items: [
        { title: "Content", quantity: 1, unit_amount_minor: 10_000_000, discount_minor: options.discount ?? 0, tax_rate_bps: 1800 },
      ],
      p_proof_ids: options.proofIds ?? [],
      p_correlation_id: corr(),
    });
    if (save.error) throw save.error;
    const submit = await author.rpc("submit_proposal_version", { p_version_id: versionId, p_correlation_id: corr() });
    if (submit.error) throw submit.error;
    if (options.approver) {
      const review = await options.approver.rpc("review_proposal_version", {
        p_version_id: versionId,
        p_decision: "approve",
        p_correlation_id: corr(),
      });
      if (review.error) throw review.error;
    }
    if (options.send) {
      const send = await author.rpc("send_proposal_version", { p_version_id: versionId, p_correlation_id: corr() });
      if (send.error) throw send.error;
    }
    return { proposalId: proposal.id, versionId };
  }

  async function invite(author: TypedClient, prospectId: string, proposalId: string | null, days = 14) {
    const { token, tokenHash } = generateInvitationToken();
    const { data, error } = await author.rpc("create_invitation", {
      p_prospect_id: prospectId,
      p_proposal_id: proposalId as string,
      p_token_hash: tokenHash,
      p_expires_in_days: days,
      p_correlation_id: corr(),
    });
    if (error) throw error;
    return { token, tokenHash, invitationId: data };
  }

  async function view(tokenHash: string) {
    const { data, error } = await anonClient().rpc("invitation_view", { p_token_hash: tokenHash });
    if (error) throw error;
    return data as Record<string, unknown> & { state: string };
  }

  beforeAll(async () => {
    users = {
      ceo: await ensureUser(admin, EMAIL.ceo, "P2 CEO"),
      sales: await ensureUser(admin, EMAIL.sales, "P2 Sales"),
      cto: await ensureUser(admin, EMAIL.cto, "P2 CTO"),
      delivery: await ensureUser(admin, EMAIL.delivery, "P2 Delivery"),
      clientA: await ensureUser(admin, EMAIL.clientA, "Client A"),
      clientB: await ensureUser(admin, EMAIL.clientB, "Client B"),
    };
    orgId = await ensureOrganization(admin, "p2-fixture", "Phase 2 Fixture Org");
    await ensureMembership(admin, orgId, users.ceo, "ceo");
    await ensureMembership(admin, orgId, users.sales, "sales");
    await ensureMembership(admin, orgId, users.cto, "cto_coo");
    await ensureMembership(admin, orgId, users.delivery, "delivery");
    prospectA = await ensureProspect(admin, orgId, users.sales, EMAIL.clientA, "Asha Client");
    prospectB = await ensureProspect(admin, orgId, users.ceo, EMAIL.clientB, "Bharat Client");
    await admin.from("prospects").update({ notes: "INTERNAL-ONLY-NOTE", status: "engaged" }).in("id", [prospectA, prospectB]);

    c = {
      ceo: await signedInClient(EMAIL.ceo),
      sales: await signedInClient(EMAIL.sales),
      cto: await signedInClient(EMAIL.cto),
      delivery: await signedInClient(EMAIL.delivery),
      clientA: await signedInClient(EMAIL.clientA),
      clientB: await signedInClient(EMAIL.clientB),
    };
  });

  it("AT-001: an invitation reveals only its own prospect and proposal, without internal fields", async () => {
    const a = await makeProposal(c.sales, prospectA, { send: true });
    const b = await makeProposal(c.ceo, prospectB, { send: true });
    const { tokenHash } = await invite(c.sales, prospectA, a.proposalId);

    const result = await view(tokenHash);
    expect(result.state).toBe("valid");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain(a.proposalId);
    expect(serialized).not.toContain(b.proposalId);
    expect(serialized).not.toContain("INTERNAL-ONLY-NOTE");
    expect(serialized).not.toContain(prospectA); // no internal ids beyond the proposal itself
    expect(serialized).not.toContain(EMAIL.clientA); // email is masked

    // After redemption the client still cannot reach another client's proposal.
    const redeem = await c.clientA.rpc("redeem_invitation", { p_token_hash: tokenHash, p_correlation_id: corr() });
    expect(redeem.error).toBeNull();
    const other = await c.clientA.rpc("client_proposal_view", { p_proposal_id: b.proposalId });
    expect(other.error?.message).toBe("NOT_FOUND");
    const list = await c.clientA.rpc("client_proposals");
    expect(JSON.stringify(list.data)).not.toContain(b.proposalId);
  });

  it("AT-002: an expired invitation is rejected without leaking data and offers a new-link path", async () => {
    const a = await makeProposal(c.sales, prospectA, { send: true });
    const { tokenHash, invitationId } = await invite(c.sales, prospectA, a.proposalId, 1);
    // Fast-forward expiry (fixture only).
    await admin.from("invitations").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", invitationId);

    expect(await view(tokenHash)).toEqual({ state: "expired" });
    const help = await anonClient().rpc("request_invitation_help", {
      p_token_hash: tokenHash,
      p_kind: "new_link",
      p_correlation_id: corr(),
    });
    expect(help.error).toBeNull();
    const redeem = await c.clientA.rpc("redeem_invitation", { p_token_hash: tokenHash, p_correlation_id: corr() });
    expect(redeem.error?.message).toBe("INVITATION_EXPIRED");
  });

  it("AT-003: a revoked invitation stops working immediately", async () => {
    const a = await makeProposal(c.sales, prospectA, { send: true });
    const { tokenHash, invitationId } = await invite(c.sales, prospectA, a.proposalId);
    expect((await view(tokenHash)).state).toBe("valid");

    const revoke = await c.sales.rpc("manage_invitation", {
      p_invitation_id: invitationId,
      p_action: "revoke",
      p_reason: "sent to the wrong address",
      p_correlation_id: corr(),
    });
    expect(revoke.error).toBeNull();
    expect(await view(tokenHash)).toEqual({ state: "revoked" });
    const redeem = await c.clientA.rpc("redeem_invitation", { p_token_hash: tokenHash, p_correlation_id: corr() });
    expect(redeem.error?.message).toBe("INVITATION_REVOKED");
  });

  it("AT-004: holding the link alone cannot accept, and another account cannot claim it", async () => {
    const a = await makeProposal(c.sales, prospectA, { send: true });
    const { tokenHash } = await invite(c.sales, prospectA, a.proposalId);
    const result = await view(tokenHash);
    const version = (result.proposal as { version: { id: string; content_hash: string } }).version;

    const anonAccept = await anonClient().rpc("accept_proposal", {
      p_proposal_id: a.proposalId,
      p_version_id: version.id,
      p_content_hash: version.content_hash,
      p_correlation_id: corr(),
    });
    expect(anonAccept.error).not.toBeNull();

    const wrongAccount = await c.clientB.rpc("redeem_invitation", { p_token_hash: tokenHash, p_correlation_id: corr() });
    expect(wrongAccount.error?.message).toBe("FORBIDDEN");
    const wrongAccept = await c.clientB.rpc("accept_proposal", {
      p_proposal_id: a.proposalId,
      p_version_id: version.id,
      p_content_hash: version.content_hash,
      p_correlation_id: corr(),
    });
    expect(wrongAccept.error?.message).toBe("NOT_FOUND");
  });

  it("AT-005: custom proposals derive totals server-side and reject invalid amounts", async () => {
    const { data: proposal } = await c.sales.rpc("create_proposal", {
      p_prospect_id: prospectA,
      p_title: "Custom scope",
      p_currency: "USD",
      p_correlation_id: corr(),
    });
    const versionId = proposal!.current_version_id!;
    const base = {
      p_version_id: versionId,
      p_title: "Custom scope",
      p_currency: "USD",
      p_valid_until: inDays(5),
      p_content: CONTENT,
      p_payment_schedule: SCHEDULE,
      p_correlation_id: corr(),
    };

    const saved = await c.sales.rpc("save_proposal_draft", {
      ...base,
      p_line_items: [
        // Client-supplied totals are ignored.
        { title: "Audit", quantity: 2.5, unit_amount_minor: 1_000_001, tax_rate_bps: 1800, total_minor: 1, gross_minor: 1 },
        { title: "Workshop", quantity: 1, unit_amount_minor: 250_000, tax_rate_bps: 0, billing_timing: "on_completion" },
      ],
    });
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({
      currency: "USD",
      subtotal_minor: 2_750_003,
      tax_minor: 450_001,
      total_minor: 3_200_004,
      requires_approval: false,
    });

    for (const lineItems of [
      [{ title: "x", quantity: 1, unit_amount_minor: 100, discount_minor: 101 }],
      [{ title: "x", quantity: -1, unit_amount_minor: 100 }],
      [{ title: "x", quantity: 1.005, unit_amount_minor: 100 }],
      [{ title: "x", quantity: 1, unit_amount_minor: "abc" }],
      [{ title: "", quantity: 1, unit_amount_minor: 100 }],
    ]) {
      const bad = await c.sales.rpc("save_proposal_draft", { ...base, p_line_items: lineItems });
      // Explicit checks raise VALIDATION_FAILED; table constraints raise 23514. Both reach clients as VALIDATION_FAILED.
      expect(bad.error, JSON.stringify(lineItems)).not.toBeNull();
      expect(fromPostgrestError(bad.error!).code, JSON.stringify(lineItems)).toBe("VALIDATION_FAILED");
    }
    const badCurrency = await c.sales.rpc("save_proposal_draft", { ...base, p_currency: "XYZ", p_line_items: [] });
    expect(badCurrency.error?.message).toBe("VALIDATION_FAILED");

    // A schedule that does not total 100% is rejected at submission.
    await c.sales.rpc("save_proposal_draft", {
      ...base,
      p_payment_schedule: [{ label: "Deposit", basis: "percent", percent_bps: 4000, due: "on_signing" }],
      p_line_items: [{ title: "Audit", quantity: 1, unit_amount_minor: 100_000 }],
    });
    const submit = await c.sales.rpc("submit_proposal_version", { p_version_id: versionId, p_correlation_id: corr() });
    expect(submit.error?.message).toBe("VALIDATION_FAILED");
  });

  it("AT-006: sent versions are immutable; edits create a new version and history is kept", async () => {
    const a = await makeProposal(c.sales, prospectA, { send: true });
    const edit = await c.sales.rpc("save_proposal_draft", {
      p_version_id: a.versionId,
      p_title: "Changed",
      p_currency: "INR",
      p_valid_until: inDays(5),
      p_content: CONTENT,
      p_payment_schedule: SCHEDULE,
      p_line_items: [{ title: "Cheaper", quantity: 1, unit_amount_minor: 1 }],
      p_correlation_id: corr(),
    });
    expect(edit.error?.message).toBe("INVALID_STATE_TRANSITION");

    const direct = await c.sales.from("proposal_versions").update({ total_minor: 1 }).eq("id", a.versionId).select();
    expect(direct.error !== null || (direct.data ?? []).length === 0).toBe(true);
    const lineEdit = await admin.from("proposal_line_items").update({ unit_amount_minor: 1 }).eq("version_id", a.versionId);
    expect(lineEdit.error?.message).toBe("INVALID_STATE_TRANSITION");

    const revision = await c.sales.rpc("create_proposal_revision", {
      p_proposal_id: a.proposalId,
      p_change_summary: "Adjusted scope after call",
      p_correlation_id: corr(),
    });
    expect(revision.error).toBeNull();
    expect(revision.data).toMatchObject({ version_number: 2, status: "draft", change_summary: "Adjusted scope after call" });
    const submit = await c.sales.rpc("submit_proposal_version", { p_version_id: revision.data!.id, p_correlation_id: corr() });
    expect(submit.error).toBeNull();
    const send = await c.sales.rpc("send_proposal_version", { p_version_id: revision.data!.id, p_correlation_id: corr() });
    expect(send.error).toBeNull();

    const { data: versions } = await c.sales
      .from("proposal_versions")
      .select("version_number, status, content_hash")
      .eq("proposal_id", a.proposalId)
      .order("version_number");
    expect(versions?.map((version) => [version.version_number, version.status])).toEqual([
      [1, "superseded"],
      [2, "sent"],
    ]);
    expect(versions?.every((version) => /^[0-9a-f]{64}$/.test(version.content_hash ?? ""))).toBe(true);
  });

  it("AT-007: acceptance binds to the exact current version and terms", async () => {
    const a = await makeProposal(c.sales, prospectA, { send: true });
    const { tokenHash } = await invite(c.sales, prospectA, a.proposalId);
    await c.clientA.rpc("redeem_invitation", { p_token_hash: tokenHash, p_correlation_id: corr() });
    const v1 = (await c.clientA.rpc("client_proposal_view", { p_proposal_id: a.proposalId })).data as {
      version: { id: string; content_hash: string };
    };

    // The proposal is revised and resent while the client has v1 open.
    const revision = await c.sales.rpc("create_proposal_revision", {
      p_proposal_id: a.proposalId,
      p_change_summary: "New price",
      p_correlation_id: corr(),
    });
    await c.sales.rpc("submit_proposal_version", { p_version_id: revision.data!.id, p_correlation_id: corr() });
    await c.sales.rpc("send_proposal_version", { p_version_id: revision.data!.id, p_correlation_id: corr() });

    const stale = await c.clientA.rpc("accept_proposal", {
      p_proposal_id: a.proposalId,
      p_version_id: v1.version.id,
      p_content_hash: v1.version.content_hash,
      p_correlation_id: corr(),
    });
    expect(stale.error?.message).toBe("VERSION_STALE");

    const v2 = (await c.clientA.rpc("client_proposal_view", { p_proposal_id: a.proposalId })).data as {
      version: { id: string; content_hash: string; version_number: number };
      previous_version: { version_number: number } | null;
    };
    expect(v2.version.version_number).toBe(2);
    expect(v2.previous_version?.version_number).toBe(1);

    const wrongHash = await c.clientA.rpc("accept_proposal", {
      p_proposal_id: a.proposalId,
      p_version_id: v2.version.id,
      p_content_hash: "0".repeat(64),
      p_correlation_id: corr(),
    });
    expect(wrongHash.error?.message).toBe("VERSION_STALE");

    const correlationId = corr();
    const accepted = await c.clientA.rpc("accept_proposal", {
      p_proposal_id: a.proposalId,
      p_version_id: v2.version.id,
      p_content_hash: v2.version.content_hash,
      p_correlation_id: correlationId,
    });
    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({ status: "accepted", accepted_version_id: v2.version.id, accepted_by: users.clientA });

    const { data: audit } = await admin
      .from("audit_logs")
      .select("actor_type, actor_id, after_summary")
      .eq("correlation_id", correlationId)
      .single();
    expect(audit).toMatchObject({
      actor_type: "client",
      actor_id: users.clientA,
      after_summary: { version_id: v2.version.id, content_hash: v2.version.content_hash },
    });

    const again = await c.clientA.rpc("accept_proposal", {
      p_proposal_id: a.proposalId,
      p_version_id: v2.version.id,
      p_content_hash: v2.version.content_hash,
      p_correlation_id: corr(),
    });
    expect(again.error?.message).toBe("INVALID_STATE_TRANSITION");
  });

  it("AT-008: a user without discount authority cannot send a proposal that needs approval", async () => {
    const a = await makeProposal(c.sales, prospectA, { discount: 1_000_000 });
    const { data: version } = await c.sales.from("proposal_versions").select("status, approval_reasons").eq("id", a.versionId).single();
    expect(version).toEqual({ status: "pending_approval", approval_reasons: ["discount"] });

    const send = await c.sales.rpc("send_proposal_version", { p_version_id: a.versionId, p_correlation_id: corr() });
    expect(send.error?.message).toBe("APPROVAL_REQUIRED");
    const selfApprove = await c.sales.rpc("review_proposal_version", {
      p_version_id: a.versionId,
      p_decision: "approve",
      p_correlation_id: corr(),
    });
    expect(selfApprove.error?.message).toBe("FORBIDDEN");
    const ctoApprove = await c.cto.rpc("review_proposal_version", {
      p_version_id: a.versionId,
      p_decision: "approve",
      p_correlation_id: corr(),
    });
    expect(ctoApprove.error?.message).toBe("FORBIDDEN");

    const approve = await c.ceo.rpc("review_proposal_version", {
      p_version_id: a.versionId,
      p_decision: "approve",
      p_note: "Discount agreed",
      p_correlation_id: corr(),
    });
    expect(approve.error).toBeNull();
    const sendAfter = await c.sales.rpc("send_proposal_version", { p_version_id: a.versionId, p_correlation_id: corr() });
    expect(sendAfter.error).toBeNull();
  });

  it("AT-009: only approved/published proof reaches prospects; withdrawal removes it immediately", async () => {
    const make = async (title: string) => {
      const { data, error } = await c.ceo.rpc("save_proof_asset", {
        p_organization_id: orgId,
        p_id: null as unknown as string,
        p_kind: "testimonial",
        p_fields: {
          title,
          quote: `${title} quote`,
          source_evidence_ref: "email",
          permission_evidence_ref: "signed release",
        },
        p_correlation_id: corr(),
      });
      if (error) throw error;
      return data.id;
    };
    const approved = await make(`Approved ${randomUUID().slice(0, 6)}`);
    const draft = await make(`Draft ${randomUUID().slice(0, 6)}`);
    const requested = await make(`Requested ${randomUUID().slice(0, 6)}`);
    const rejected = await make(`Rejected ${randomUUID().slice(0, 6)}`);
    const transition = (id: string, to: "approved" | "permission_requested" | "rejected" | "withdrawn", reason?: string) =>
      c.ceo.rpc("transition_proof_asset", { p_id: id, p_to: to, p_reason: reason, p_correlation_id: corr() });
    expect((await transition(approved, "approved")).error).toBeNull();
    expect((await transition(requested, "permission_requested")).error).toBeNull();
    expect((await transition(rejected, "rejected", "client declined")).error).toBeNull();

    for (const id of [draft, requested, rejected]) {
      const attach = await c.sales.rpc("save_proposal_draft", {
        p_version_id: (await c.sales.rpc("create_proposal", {
          p_prospect_id: prospectA,
          p_title: "Proof attach",
          p_currency: "INR",
          p_correlation_id: corr(),
        })).data!.current_version_id!,
        p_title: "Proof attach",
        p_currency: "INR",
        p_valid_until: inDays(5),
        p_content: CONTENT,
        p_payment_schedule: SCHEDULE,
        p_line_items: [],
        p_proof_ids: [id],
        p_correlation_id: corr(),
      });
      expect(attach.error?.message).toBe("VALIDATION_FAILED");
    }

    const a = await makeProposal(c.sales, prospectA, { send: true, proofIds: [approved] });
    const { tokenHash } = await invite(c.sales, prospectA, a.proposalId);
    const before = await view(tokenHash);
    expect(JSON.stringify(before)).toContain(approved);

    const sales = await c.sales.rpc("transition_proof_asset", { p_id: approved, p_to: "withdrawn", p_reason: "x", p_correlation_id: corr() });
    expect(sales.error?.message).toBe("FORBIDDEN");
    expect((await transition(approved, "withdrawn", "client withdrew consent")).error).toBeNull();
    const after = await view(tokenHash);
    expect(JSON.stringify(after)).not.toContain(approved);
  });

  describe("least privilege", () => {
    it("delivery and CTO cannot read proposals; sales only sees their own", async () => {
      const ceoProposal = await makeProposal(c.ceo, prospectB, { send: false });
      const salesProposal = await makeProposal(c.sales, prospectA, { send: false });

      for (const client of [c.delivery, c.cto]) {
        const { data } = await client.from("proposals").select("id").in("id", [ceoProposal.proposalId, salesProposal.proposalId]);
        expect(data ?? []).toEqual([]);
        const lines = await client.from("proposal_line_items").select("id").eq("proposal_id", salesProposal.proposalId);
        expect(lines.data ?? []).toEqual([]);
      }
      const { data: own } = await c.sales.from("proposals").select("id").in("id", [ceoProposal.proposalId, salesProposal.proposalId]);
      expect(own?.map((row) => row.id)).toEqual([salesProposal.proposalId]);

      const cannotEdit = await c.sales.rpc("save_proposal_draft", {
        p_version_id: ceoProposal.versionId,
        p_title: "x",
        p_currency: "INR",
        p_valid_until: inDays(5),
        p_content: CONTENT,
        p_payment_schedule: SCHEDULE,
        p_line_items: [],
        p_correlation_id: corr(),
      });
      expect(cannotEdit.error?.message).toBe("FORBIDDEN");
    });

    it("sales cannot invite or create proposals for prospects they do not own", async () => {
      const proposal = await c.sales.rpc("create_proposal", {
        p_prospect_id: prospectB,
        p_title: "Not mine",
        p_currency: "INR",
        p_correlation_id: corr(),
      });
      expect(proposal.error?.message).toBe("FORBIDDEN");
      const { tokenHash } = generateInvitationToken();
      const invitation = await c.sales.rpc("create_invitation", {
        p_prospect_id: prospectB,
        p_proposal_id: null as unknown as string,
        p_token_hash: tokenHash,
        p_expires_in_days: 7,
        p_correlation_id: corr(),
      });
      expect(invitation.error?.message).toBe("FORBIDDEN");
    });

    it("invitation token hashes are not readable from any client session", async () => {
      const result = await c.ceo.from("invitations").select("token_hash").limit(1);
      expect(result.error).not.toBeNull();
    });

    it("clients have no direct table access to proposals or proof", async () => {
      for (const table of ["proposals", "proposal_versions", "proposal_line_items", "proof_assets", "prospects", "invitations"] as const) {
        const { data } = await c.clientA.from(table).select("id").limit(1);
        expect(data ?? [], table).toEqual([]);
      }
    });

    it("the bound email lookup is server-only", async () => {
      const { tokenHash } = await invite(c.sales, prospectA, null);
      for (const client of [anonClient(), c.clientA, c.ceo]) {
        const { data, error } = await client.rpc("invitation_contact", { p_token_hash: tokenHash });
        expect(error !== null || data === null).toBe(true);
      }
    });
  });
});
