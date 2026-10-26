import { AppError } from "@/server/errors";
import type { Enums } from "@/server/supabase/database.types";

/**
 * Permission keys known to the application. Grants live in the
 * `role_permissions` table (seeded in supabase/migrations); this list only
 * types them. Unknown keys from the database are ignored.
 */
export const PERMISSIONS = [
  "members.read",
  "members.manage",
  "prospects.read_all",
  "prospects.write",
  "prospects.write_own",
  "prospects.create",
  "proposals.read_all",
  "proposals.manage",
  "proposals.manage_own",
  "proposals.approve",
  "proof.read",
  "proof.manage",
  "proof.approve",
  "pricing.read",
  "finance.read",
  "contracts.read",
  "contracts.manage",
  "contracts.templates",
  "billing.manage",
  "meetings.read_all",
  "meetings.manage",
  "scheduling.configure",
  "integrations.monitor",
  "onboarding.manage",
  "workspaces.read_all",
  "workspaces.manage",
  "workspaces.override",
  "knowledge.manage",
  "ai.monitor",
  "ai.copilot",
  "operations.manage",
  "system.configure",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type MemberRole = Enums<"member_role">;

export const ROLE_LABELS: Record<MemberRole, string> = {
  ceo: "CEO",
  cto_coo: "CTO / COO",
  delivery: "Delivery",
  sales: "Sales",
};

export type MemberContext = {
  userId: string;
  email: string | null;
  displayName: string;
  organizationId: string;
  organizationName: string;
  membershipId: string;
  role: MemberRole;
  permissions: ReadonlySet<Permission>;
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function toPermissionSet(rows: ReadonlyArray<{ permission_key: string; allowed: boolean }>) {
  const set = new Set<Permission>();
  for (const row of rows) {
    if (row.allowed && isPermission(row.permission_key)) set.add(row.permission_key);
  }
  return set;
}

export function can(context: Pick<MemberContext, "permissions">, permission: Permission): boolean {
  return context.permissions.has(permission);
}

/** Throw FORBIDDEN unless the member holds the permission. UI hiding is not authorization. */
export function assertCan(context: Pick<MemberContext, "permissions">, permission: Permission): void {
  if (!can(context, permission)) {
    throw new AppError("FORBIDDEN", { detail: `missing permission ${permission}` });
  }
}
