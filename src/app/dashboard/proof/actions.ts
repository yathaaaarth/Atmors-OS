"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { proofFormSchema } from "@/modules/proof/schema";
import { formObject } from "@/server/actions/form-data";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { fromPostgrestError, fromZodError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

export async function saveProofAsset(id: string | null, input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("proof.save", async (correlationId) => {
    const context = await requireMemberContext();
    const parsed = proofFormSchema.safeParse(input);
    if (!parsed.success) throw fromZodError(parsed.error);
    const { kind, ...fields } = parsed.data;
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("save_proof_asset", {
      p_organization_id: context.organizationId,
      p_id: id ?? (null as unknown as string),
      p_kind: kind,
      p_fields: fields,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/proof");
    revalidatePath(`/dashboard/proof/${data.id}`);
    return { id: data.id };
  });
}

const transitionSchema = z.object({
  id: z.uuid(),
  to: z.enum(["draft", "permission_requested", "approved", "published", "withdrawn", "rejected"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function transitionProofAsset(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proof.transition", async (correlationId) => {
    await requireMemberContext();
    const parsed = transitionSchema.safeParse(formObject(formData, ["id", "to", "reason"]));
    if (!parsed.success) throw fromZodError(parsed.error);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("transition_proof_asset", {
      p_id: parsed.data.id,
      p_to: parsed.data.to,
      p_reason: parsed.data.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/proof");
    revalidatePath(`/dashboard/proof/${parsed.data.id}`);
    return null;
  });
}
