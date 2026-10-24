"use server";

import { revalidatePath } from "next/cache";

import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { assertCan } from "@/server/authorization/permissions";
import { fromPostgrestError, fromZodError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { updateMembershipSchema } from "./schema";

export async function updateMembership(
  input: unknown,
): Promise<ActionResult<{ role: string; status: string }>> {
  return runAction("membership.update", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "members.manage");

    const parsed = updateMembershipSchema.safeParse(input);
    if (!parsed.success) throw fromZodError(parsed.error);

    // The RPC re-checks permission, blocks self-changes, and writes the audit
    // entry and workflow event in the same transaction.
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("update_membership", {
      p_membership_id: parsed.data.membershipId,
      p_role: parsed.data.role,
      p_status: parsed.data.status,
      p_reason: parsed.data.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);

    revalidatePath("/dashboard/team");
    revalidatePath("/dashboard/audit");
    return { role: data.role, status: data.status };
  });
}
