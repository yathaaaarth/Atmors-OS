"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

const taskSchema = z.object({
  taskId: z.uuid(),
  outcome: z.enum(["done", "cancelled"]),
  resolution: z.string().trim().max(2000).optional(),
});

export async function completeTask(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("ops_task.complete", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(taskSchema, formObject(formData, ["taskId", "outcome", "resolution"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("complete_ops_task", {
      p_task_id: values.taskId,
      p_outcome: values.outcome,
      p_resolution: values.resolution,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard");
    return null;
  });
}
