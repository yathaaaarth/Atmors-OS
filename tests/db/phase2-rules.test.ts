/**
 * SQL business rules for Phase 2 on an in-process Postgres. Complements
 * tests/security (which needs the hosted project) and runs in CI without
 * secrets. Covers cases the hosted suite cannot set up, such as expiry.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { migratedDatabase } from "../support/pglite-db";

type Db = Awaited<ReturnType<typeof migratedDatabase>>;

const CONTENT = JSON.stringify({ summary: "Grow pipeline", scope: "LinkedIn content", injected: "drop me" });
const SCHEDULE = JSON.stringify([{ label: "All", basis: "percent", percent_bps: 10000, due: "on_signing" }]);
const LINES = JSON.stringify([{ title: "Content", quantity: 1, unit_amount_minor: 100000, tax_rate_bps: 1800 }]);

describe("Phase 2 SQL rules (PGlite)", () => {
  let d: Db;
  const u: Record<string, string> = {};
  let org: string;
  let prospect: string;

  async function sentProposal(validDays = 10) {
    const [proposal] = await d.as<{ id: string; current_version_id: string }>(
      u.sales,
      `select * from create_proposal($1, 'Retainer', 'INR', 'c')`,
      [prospect],
    );
    const versionId = proposal.current_version_id;
    await d.as(
      u.sales,
      `select save_proposal_draft($1, 'Retainer', 'INR', current_date + $2::int, $3::jsonb, $4::jsonb, $5::jsonb, '{}', false, false, 'c')`,
      [versionId, validDays, CONTENT, SCHEDULE, LINES],
    );
    await d.as(u.sales, `select submit_proposal_version($1, 'c')`, [versionId]);
    await d.as(u.sales, `select send_proposal_version($1, 'c')`, [versionId]);
    return { proposalId: proposal.id, versionId };
  }

  async function redeem(proposalId: string, hash: string) {
    await d.as(u.sales, `select create_invitation($1, $2, $3, 14, 'c')`, [prospect, proposalId, hash]);
    await d.as(u.client, `select redeem_invitation($1, 'c')`, [hash]);
  }

  beforeAll(async () => {
    d = await migratedDatabase();
    for (const [key, email] of Object.entries({
      ceo: "ceo@atmors.test",
      sales: "sales@atmors.test",
      client: "founder@acme.test",
    })) {
      [{ id: u[key] }] = await d.as<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [email]);
    }
    [{ id: org }] = await d.as<{ id: string }>(null, `insert into organizations (name, slug) values ('Atmors', 'atmors') returning id`);
    await d.as(null, `insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'ceo'), ($1, $3, 'sales')`, [
      org,
      u.ceo,
      u.sales,
    ]);
    [{ id: prospect }] = await d.as<{ id: string }>(
      u.sales,
      `select id from create_prospect($1, $2, 'Founder', 'Acme', 'Founder@Acme.test', 'email', null, null, null, null, null, 'c')`,
      [org, u.sales],
    );
  });

  it("creates a profile for every auth user", async () => {
    const [{ n }] = await d.as<{ n: number }>(null, `select count(*)::int as n from profiles`);
    expect(n).toBe(3);
  });

  it("normalises and deduplicates prospect email", async () => {
    const [row] = await d.as<{ normalized_email: string }>(null, `select normalized_email from prospects where id = $1`, [prospect]);
    expect(row.normalized_email).toBe("founder@acme.test");
    expect(
      await d.errorOf(u.sales, `select create_prospect($1, $2, 'Dup', null, ' FOUNDER@acme.test ', 'email', null, null, null, null, null, 'c')`, [
        org,
        u.sales,
      ]),
    ).toBe("CONFLICT");
  });

  it("enforces the prospect state machine in the database", async () => {
    expect(await d.errorOf(u.sales, `select transition_prospect($1, 'converted', 'skip', 'c')`, [prospect])).toBe(
      "INVALID_STATE_TRANSITION",
    );
    expect(await d.errorOf(u.sales, `select transition_prospect($1, 'contacted', 'called', 'c')`, [prospect])).toBeNull();
  });

  it("keeps only known content sections", async () => {
    const { versionId } = await sentProposal();
    const [row] = await d.as<{ content: Record<string, unknown> }>(null, `select content from proposal_versions where id = $1`, [versionId]);
    expect(row.content).not.toHaveProperty("injected");
    expect(row.content).toMatchObject({ summary: "Grow pipeline", deliverables: [] });
  });

  it("rejects acceptance of an expired version (PROPOSAL_EXPIRED)", async () => {
    const { proposalId, versionId } = await sentProposal();
    await redeem(proposalId, "1".repeat(64));
    // Backdate as superuser; the immutability trigger blocks this for everyone else.
    await d.db.exec(`alter table proposal_versions disable trigger proposal_versions_guard`);
    await d.as(null, `update proposal_versions set valid_until = current_date - 1 where id = $1`, [versionId]);
    await d.db.exec(`alter table proposal_versions enable trigger proposal_versions_guard`);

    const [{ hash }] = await d.as<{ hash: string }>(null, `select content_hash as hash from proposal_versions where id = $1`, [versionId]);
    expect(await d.errorOf(u.client, `select accept_proposal($1, $2, $3, 'c')`, [proposalId, versionId, hash])).toBe(
      "PROPOSAL_EXPIRED",
    );
    const [view] = await d.as<{ v: { version: { is_expired: boolean } } }>(u.client, `select client_proposal_view($1) as v`, [proposalId]);
    expect(view.v.version.is_expired).toBe(true);
  });

  it("refuses to submit a draft whose valid-until date has passed", async () => {
    const [proposal] = await d.as<{ current_version_id: string }>(u.sales, `select * from create_proposal($1, 'Old', 'INR', 'c')`, [prospect]);
    await d.as(
      u.sales,
      `select save_proposal_draft($1, 'Old', 'INR', current_date - 1, $2::jsonb, $3::jsonb, $4::jsonb, '{}', false, false, 'c')`,
      [proposal.current_version_id, CONTENT, SCHEDULE, LINES],
    );
    expect(await d.errorOf(u.sales, `select submit_proposal_version($1, 'c')`, [proposal.current_version_id])).toBe("VALIDATION_FAILED");
  });

  it("makes proposal events and audit logs append-only", async () => {
    // Row triggers only fire on existing rows, so make sure there is one of each.
    await d.as(u.sales, `select log_outreach($1, 'email', 'outbound', 'Intro sent', null, null, 'c')`, [prospect]);
    expect(await d.errorOf(null, `update proposal_events set event_type = 'proposal.forged'`)).toBe("APPEND_ONLY");
    expect(await d.errorOf(null, `delete from audit_logs`)).toBe("APPEND_ONLY");
    expect(await d.errorOf(null, `delete from outreach_events`)).toBe("APPEND_ONLY");
  });

  it("never deletes proposal versions", async () => {
    expect(await d.errorOf(null, `delete from proposal_versions`)).toBe("INVALID_STATE_TRANSITION");
  });

  it("records client actions with the client actor type", async () => {
    const { proposalId, versionId } = await sentProposal();
    await redeem(proposalId, "2".repeat(64));
    const [{ hash }] = await d.as<{ hash: string }>(null, `select content_hash as hash from proposal_versions where id = $1`, [versionId]);
    await d.as(u.client, `select accept_proposal($1, $2, $3, 'accept-corr')`, [proposalId, versionId, hash]);
    const [audit] = await d.as<{ actor_type: string }>(null, `select actor_type from audit_logs where correlation_id = 'accept-corr'`);
    expect(audit.actor_type).toBe("client");
  });
});
