"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

export async function retryNotification(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("notification.retry", async (correlationId) => {
    await requireMemberContext();
    const { id } = parseInput(z.object({ id: z.uuid() }), formObject(formData, ["id"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("retry_notification", { p_id: id, p_correlation_id: correlationId });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/operations");
    return null;
  });
}
