/**
 * Row Level Security and privileged-RPC tests (PRD §2, AT-023, AT-024, AT-026,
 * AT-032). Runs against the hosted dev Supabase project using dedicated
 * fixture organizations and users; never point this at production.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

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
  ceo: "rls-ceo+clientos@example.com",
  cto: "rls-cto+clientos@example.com",
  delivery: "rls-delivery+clientos@example.com",
  outsider: "rls-outsider+clientos@example.com",
  otherOrgAdmin: "rls-other-admin+clientos@example.com",
};

type Fixture = {
  orgId: string;
  otherOrgId: string;
  users: Record<keyof typeof EMAIL, string>;
  memberships: { ceo: string; cto: string; delivery: string; otherOrgAdmin: string };
  prospects: { ownedByCeo: string; ownedByDelivery: string; otherOrg: string };
  clients: Record<keyof typeof EMAIL, TypedClient>;
};

describe.skipIf(!hasSupabaseTestEnv)("RLS and authorization boundaries", () => {
  let fx: Fixture;
  const admin = hasSupabaseTestEnv ? adminClient() : (undefined as unknown as TypedClient);

  beforeAll(async () => {
    const users = {
      ceo: await ensureUser(admin, EMAIL.ceo, "RLS CEO"),
      cto: await ensureUser(admin, EMAIL.cto, "RLS CTO"),
      delivery: await ensureUser(admin, EMAIL.delivery, "RLS Delivery"),
      outsider: await ensureUser(admin, EMAIL.outsider, "RLS Outsider"),
      otherOrgAdmin: await ensureUser(admin, EMAIL.otherOrgAdmin, "RLS Other Admin"),
    };
    const orgId = await ensureOrganization(admin, "rls-fixture", "RLS Fixture Org");
    const otherOrgId = await ensureOrganization(admin, "rls-fixture-other", "RLS Fixture Other Org");

    // Reset roles each run; earlier runs change them through the RPC.
    const memberships = {
      ceo: await ensureMembership(admin, orgId, users.ceo, "ceo"),
      cto: await ensureMembership(admin, orgId, users.cto, "cto_coo"),
      delivery: await ensureMembership(admin, orgId, users.delivery, "delivery"),
      otherOrgAdmin: await ensureMembership(admin, otherOrgId, users.otherOrgAdmin, "cto_coo"),
    };

    const prospects = {
      ownedByCeo: await ensureProspect(admin, orgId, users.ceo, "prospect-ceo@example.com"),
      ownedByDelivery: await ensureProspect(admin, orgId, users.delivery, "prospect-delivery@example.com"),
      otherOrg: await ensureProspect(admin, otherOrgId, users.otherOrgAdmin, "prospect-other@example.com"),
    };

    const clients = {
      ceo: await signedInClient(EMAIL.ceo),
      cto: await signedInClient(EMAIL.cto),
      delivery: await signedInClient(EMAIL.delivery),
      outsider: await signedInClient(EMAIL.outsider),
      otherOrgAdmin: await signedInClient(EMAIL.otherOrgAdmin),
    };

    fx = { orgId, otherOrgId, users, memberships, prospects, clients };
  });

  describe("anonymous sessions", () => {
    it("cannot read any table", async () => {
      const anon = anonClient();
      for (const table of ["organizations", "profiles", "organization_memberships", "prospects", "audit_logs"] as const) {
        const { data, error } = await anon.from(table).select("*").limit(1);
        // Either a permission error or an empty result; never data.
        expect(error !== null || (data ?? []).length === 0, `anon read ${table}`).toBe(true);
      }
    });

    it("cannot call the membership RPC", async () => {
      const { error } = await anonClient().rpc("update_membership", {
        p_membership_id: fx.memberships.delivery,
        p_role: "ceo",
        p_reason: "anon attempt",
        p_correlation_id: randomUUID(),
      });
      expect(error).not.toBeNull();
    });
  });

  describe("prospects", () => {
    it("CEO sees every prospect in their organization and none outside it", async () => {
      const { data, error } = await fx.clients.ceo.from("prospects").select("id, organization_id");
      expect(error).toBeNull();
      const ids = (data ?? []).map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([fx.prospects.ownedByCeo, fx.prospects.ownedByDelivery]));
      expect(ids).not.toContain(fx.prospects.otherOrg);
    });

    it("delivery only sees prospects they own (AT-023)", async () => {
      const { data, error } = await fx.clients.delivery.from("prospects").select("id");
      expect(error).toBeNull();
      expect((data ?? []).map((row) => row.id)).toEqual([fx.prospects.ownedByDelivery]);
    });

    it("guessing another organization's prospect id returns nothing (AT-024)", async () => {
      const { data, error } = await fx.clients.ceo.from("prospects").select("id").eq("id", fx.prospects.otherOrg);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("users without a membership see nothing", async () => {
      const { data } = await fx.clients.outsider.from("prospects").select("id");
      expect(data ?? []).toEqual([]);
    });

    it("client sessions cannot write prospects directly, even with full permissions", async () => {
      const insert = await fx.clients.cto
        .from("prospects")
        .insert({ organization_id: fx.orgId, owner_user_id: fx.users.cto, name: "Direct insert" });
      expect(insert.error).not.toBeNull();

      await fx.clients.cto.from("prospects").update({ name: "Tampered" }).eq("id", fx.prospects.ownedByCeo);
      const { data } = await admin.from("prospects").select("name").eq("id", fx.prospects.ownedByCeo).single();
      expect(data?.name).not.toBe("Tampered");
    });
  });

  describe("memberships and roles", () => {
    it("delivery cannot list other members", async () => {
      const { data } = await fx.clients.delivery.from("organization_memberships").select("id");
      expect((data ?? []).map((row) => row.id)).toEqual([fx.memberships.delivery]);
    });

    it("members cannot change their own role by writing the table", async () => {
      await fx.clients.delivery.from("organization_memberships").update({ role: "ceo" }).eq("id", fx.memberships.delivery);
      const { data } = await admin.from("organization_memberships").select("role").eq("id", fx.memberships.delivery).single();
      expect(data?.role).toBe("delivery");
    });

    it("role permissions cannot be edited from a client session", async () => {
      await fx.clients.cto.from("role_permissions").update({ allowed: true }).eq("role", "delivery");
      const insert = await fx.clients.cto
        .from("role_permissions")
        .insert({ role: "delivery", permission_key: "finance.read" });
      expect(insert.error).not.toBeNull();
      const { data } = await admin.from("role_permissions").select("permission_key").eq("role", "delivery");
      expect(data ?? []).toEqual([]);
    });

    it("delivery and CEO lack members.manage and get FORBIDDEN from the RPC", async () => {
      for (const client of [fx.clients.delivery, fx.clients.ceo]) {
        const { error } = await client.rpc("update_membership", {
          p_membership_id: fx.memberships.cto,
          p_role: "delivery",
          p_reason: "escalation attempt",
          p_correlation_id: randomUUID(),
        });
        expect(error?.message).toBe("FORBIDDEN");
      }
    });

    it("an admin of another organization cannot manage this organization's members", async () => {
      const { error } = await fx.clients.otherOrgAdmin.rpc("update_membership", {
        p_membership_id: fx.memberships.delivery,
        p_role: "ceo",
        p_reason: "cross-org attempt",
        p_correlation_id: randomUUID(),
      });
      expect(error?.message).toBe("FORBIDDEN");
    });

    it("an admin cannot change their own role", async () => {
      const { error } = await fx.clients.cto.rpc("update_membership", {
        p_membership_id: fx.memberships.cto,
        p_role: "delivery",
        p_reason: "self change",
        p_correlation_id: randomUUID(),
      });
      expect(error?.message).toBe("FORBIDDEN");
    });

    it("requires a reason", async () => {
      const { error } = await fx.clients.cto.rpc("update_membership", {
        p_membership_id: fx.memberships.delivery,
        p_role: "ceo",
        p_reason: " ",
        p_correlation_id: randomUUID(),
      });
      expect(error?.message).toBe("VALIDATION_FAILED");
    });

    it("an authorized change is applied and audited with actor, reason and correlation id (AT-026, AT-032)", async () => {
      const correlationId = randomUUID();
      const { data, error } = await fx.clients.cto.rpc("update_membership", {
        p_membership_id: fx.memberships.delivery,
        p_role: "ceo",
        p_reason: "RLS test promotion",
        p_correlation_id: correlationId,
      });
      expect(error).toBeNull();
      expect(data?.role).toBe("ceo");

      const { data: audit } = await admin
        .from("audit_logs")
        .select("actor_type, actor_id, action, entity_id, before_summary, after_summary, reason")
        .eq("correlation_id", correlationId)
        .single();
      expect(audit).toMatchObject({
        actor_type: "user",
        actor_id: fx.users.cto,
        action: "membership.updated",
        entity_id: fx.memberships.delivery,
        before_summary: { role: "delivery", status: "active" },
        after_summary: { role: "ceo", status: "active" },
        reason: "RLS test promotion",
      });

      const { data: events } = await admin
        .from("workflow_events")
        .select("event_type")
        .eq("correlation_id", correlationId);
      expect(events).toEqual([{ event_type: "membership.updated" }]);

      // Restore through the audited path as well.
      const restore = await fx.clients.cto.rpc("update_membership", {
        p_membership_id: fx.memberships.delivery,
        p_role: "delivery",
        p_reason: "RLS test restore",
        p_correlation_id: randomUUID(),
      });
      expect(restore.error).toBeNull();
    });
  });

  describe("audit log", () => {
    it("is readable only with audit.read", async () => {
      const delivery = await fx.clients.delivery.from("audit_logs").select("id").limit(1);
      expect(delivery.data ?? []).toEqual([]);
      const cto = await fx.clients.cto.from("audit_logs").select("id").eq("organization_id", fx.orgId).limit(1);
      expect(cto.error).toBeNull();
      expect((cto.data ?? []).length).toBeGreaterThan(0);
    });

    it("cannot be inserted from client sessions", async () => {
      const { error } = await fx.clients.cto.from("audit_logs").insert({
        organization_id: fx.orgId,
        actor_type: "user",
        action: "forged.entry",
        entity_type: "test",
        correlation_id: randomUUID(),
      });
      expect(error).not.toBeNull();
    });

    it("is append-only even for the service role", async () => {
      const { data: row } = await admin.from("audit_logs").select("id").eq("organization_id", fx.orgId).limit(1).single();
      expect(row).not.toBeNull();
      const update = await admin.from("audit_logs").update({ reason: "rewritten" } as never).eq("id", row!.id);
      expect(update.error).not.toBeNull();
      const remove = await admin.from("audit_logs").delete().eq("id", row!.id);
      expect(remove.error).not.toBeNull();
    });
  });

  describe("profiles", () => {
    it("teammates are visible, outsiders and other organizations are not", async () => {
      const { data } = await fx.clients.delivery.from("profiles").select("id");
      const ids = (data ?? []).map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([fx.users.delivery, fx.users.ceo, fx.users.cto]));
      expect(ids).not.toContain(fx.users.outsider);
      expect(ids).not.toContain(fx.users.otherOrgAdmin);
    });

    it("users can edit their own display name but not their status", async () => {
      const rename = await fx.clients.delivery
        .from("profiles")
        .update({ display_name: "RLS Delivery" })
        .eq("id", fx.users.delivery);
      expect(rename.error).toBeNull();

      const statusChange = await fx.clients.delivery
        .from("profiles")
        .update({ status: "active" })
        .eq("id", fx.users.delivery);
      expect(statusChange.error).not.toBeNull();
    });
  });
});
