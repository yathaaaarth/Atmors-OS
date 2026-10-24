import "server-only";

import { redirect } from "next/navigation";

import { getMemberContext } from "@/server/authorization/member-context";
import { can, type MemberContext, type Permission } from "@/server/authorization/permissions";

export type MemberPageAccess = { allowed: true; context: MemberContext } | { allowed: false };

/**
 * Per-page access check. Layouts do not re-render on client navigation, so
 * every dashboard page calls this itself rather than relying on the layout.
 */
export async function memberPageAccess(path: string, permission?: Permission): Promise<MemberPageAccess> {
  const result = await getMemberContext();
  if (result.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent(path)}`);
  if (result.status === "not_member") return { allowed: false };
  if (permission && !can(result.context, permission)) return { allowed: false };
  return { allowed: true, context: result.context };
}
