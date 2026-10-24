import "server-only";

import { cache } from "react";

import { getSessionUser } from "@/server/auth/session";
import { AppError, fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { toPermissionSet, type MemberContext } from "./permissions";

export type MemberContextResult =
  | { status: "unauthenticated" }
  | { status: "not_member"; userId: string }
  | { status: "member"; context: MemberContext };

/**
 * Resolve the caller's internal membership and permissions through RLS-bound
 * queries. Atmors runs a single organization today; if a user ever holds
 * several active memberships the oldest is used until org switching exists.
 */
export const getMemberContext = cache(async (): Promise<MemberContextResult> => {
  const user = await getSessionUser();
  if (!user) return { status: "unauthenticated" };

  const supabase = await createSupabaseServerClient();

  const { data: membership, error: membershipError } = await supabase
    .from("organization_memberships")
    .select("id, organization_id, role, organizations(name)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipError) throw fromPostgrestError(membershipError);
  if (!membership) return { status: "not_member", userId: user.id };

  const [{ data: profile, error: profileError }, { data: grants, error: grantsError }] = await Promise.all([
    supabase.from("profiles").select("display_name, status").eq("id", user.id).maybeSingle(),
    supabase.from("role_permissions").select("permission_key, allowed").eq("role", membership.role),
  ]);
  if (profileError) throw fromPostgrestError(profileError);
  if (grantsError) throw fromPostgrestError(grantsError);
  if (!profile || profile.status !== "active") return { status: "not_member", userId: user.id };

  return {
    status: "member",
    context: {
      userId: user.id,
      email: user.email,
      displayName: profile.display_name || user.email || "Team member",
      organizationId: membership.organization_id,
      organizationName: membership.organizations?.name ?? "Atmors",
      membershipId: membership.id,
      role: membership.role,
      permissions: toPermissionSet(grants ?? []),
    },
  };
});

/** For server actions and route handlers: throw unless the caller is an active member. */
export async function requireMemberContext(): Promise<MemberContext> {
  const result = await getMemberContext();
  if (result.status === "unauthenticated") throw new AppError("UNAUTHENTICATED");
  if (result.status === "not_member") throw new AppError("FORBIDDEN", { detail: "no active membership" });
  return result.context;
}
