import { requireMemberContext } from "@/server/authorization/member-context";
import { handleRoute } from "@/server/http/route";

/** The caller's own role and permissions. Reference route for the error envelope. */
export const GET = handleRoute(async () => {
  const context = await requireMemberContext();
  return {
    user_id: context.userId,
    organization_id: context.organizationId,
    role: context.role,
    permissions: [...context.permissions].sort(),
  };
});
