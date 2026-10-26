"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { answersFromForm, clientOnboardingSchema } from "@/modules/onboarding/schema";
import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireSessionUser } from "@/server/auth/session";
import { AppError, fromPostgrestError } from "@/server/errors";
import type { Json } from "@/server/supabase/database.types";
import { createSupabaseServerClient } from "@/server/supabase/server";

/** Save progress or submit a new revision. The database validates every answer. */
export async function saveOnboarding(_: unknown, formData: FormData): Promise<ActionResult<{ status: string; submitted: boolean }>> {
  return runAction("onboarding.client_save", async (correlationId) => {
    await requireSessionUser();
    const intent = formData.get("intent") === "submit" ? "submit" : "draft";
    const supabase = await createSupabaseServerClient();
    const { data: current, error: loadError } = await supabase.rpc("client_onboarding");
    if (loadError) throw fromPostgrestError(loadError);
    if (!current) throw new AppError("NOT_FOUND");
    const onboarding = clientOnboardingSchema.parse(current);
    const answers = answersFromForm(onboarding.questions, formData);

    const { data, error } = await supabase.rpc(intent === "submit" ? "client_submit_onboarding" : "client_save_onboarding_draft", {
      p_answers: answers as Json,
      p_correlation_id: correlationId,
    });
    if (error) {
      const appError = fromPostgrestError(error);
      // Required-answer and format errors carry which questions need attention.
      const detail = error.details ?? "";
      if (appError.code === "VALIDATION_FAILED" && detail) {
        throw new AppError("VALIDATION_FAILED", {
          message: detail.startsWith("required: ")
            ? "Please answer the required questions before submitting."
            : "Some answers need attention.",
          fieldErrors: { answers: [detail.replace("required: ", "Missing: ")] },
        });
      }
      throw appError;
    }
    revalidatePath("/portal/onboarding");
    revalidatePath("/portal");
    return { status: clientOnboardingSchema.parse(data).status, submitted: intent === "submit" };
  });
}

const grantSchema = z.object({ grantId: z.uuid(), note: z.string().trim().max(2000).optional() });

export async function confirmAccessGrant(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("access_grant.client_confirm", async (correlationId) => {
    await requireSessionUser();
    const values = parseInput(grantSchema, formObject(formData, ["grantId", "note"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("client_confirm_access_grant", {
      p_grant_id: values.grantId,
      p_note: values.note,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/portal/onboarding");
    return null;
  });
}

export async function removeAsset(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("asset.client_remove", async (correlationId) => {
    await requireSessionUser();
    const { assetId } = parseInput(z.object({ assetId: z.uuid() }), formObject(formData, ["assetId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("remove_asset", { p_asset_id: assetId, p_correlation_id: correlationId });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/portal/onboarding");
    return null;
  });
}
