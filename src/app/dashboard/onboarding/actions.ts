"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { questionSchema } from "@/modules/onboarding/schema";
import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { assertCan } from "@/server/authorization/permissions";
import { requireMemberContext } from "@/server/authorization/member-context";
import { analyzeOnboarding } from "@/server/ai/assistant";
import { AppError, fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

function revalidateOnboarding(onboardingId?: string) {
  if (onboardingId) revalidatePath(`/dashboard/onboarding/${onboardingId}`);
  revalidatePath("/dashboard/onboarding");
  revalidatePath("/dashboard");
}

const reviewSchema = z.object({
  onboardingId: z.uuid(),
  submissionId: z.uuid(),
  decision: z.enum(["approved", "needs_information"]),
});

/** Approve, or ask for specific missing information (one request per line, optionally "question_key: message"). */
export async function reviewOnboarding(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("onboarding.review", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(reviewSchema, formObject(formData, ["onboardingId", "submissionId", "decision"]));
    const keys = new Set(formData.getAll("questionKeys").map(String));
    const raw = String(formData.get("requests") ?? "");
    const reasons = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^([a-z][a-z0-9_]*)\s*:\s*(.+)$/.exec(line);
        return match && keys.has(match[1]) ? { question_key: match[1], message: match[2] } : { message: line };
      });
    if (values.decision === "needs_information" && reasons.length === 0) {
      throw new AppError("VALIDATION_FAILED", { message: "Say what information is missing, one item per line." });
    }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("review_onboarding", {
      p_onboarding_id: values.onboardingId,
      p_submission_id: values.submissionId,
      p_decision: values.decision,
      p_reasons: values.decision === "approved" ? [] : reasons,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateOnboarding(values.onboardingId);
    return null;
  });
}

export async function startOnboarding(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("onboarding.start", async (correlationId) => {
    await requireMemberContext();
    const { prospectId } = parseInput(z.object({ prospectId: z.uuid() }), formObject(formData, ["prospectId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("start_onboarding", { p_prospect_id: prospectId, p_correlation_id: correlationId });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/dashboard/prospects/${prospectId}`);
    revalidateOnboarding();
    return null;
  });
}

const grantSchema = z.object({
  onboardingId: z.uuid(),
  prospectId: z.uuid(),
  platform: z.string().trim().min(1, "Which platform?").max(120),
  scope: z.string().trim().min(1, "What access is needed?").max(500),
  instructions: z.string().trim().max(4000).optional(),
});

export async function requestAccessGrant(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("access_grant.request", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(grantSchema, formObject(formData, ["onboardingId", "prospectId", "platform", "scope", "instructions"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("request_access_grant", {
      p_prospect_id: values.prospectId,
      p_platform: values.platform,
      p_requested_scope: values.scope,
      p_instructions: values.instructions as string,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateOnboarding(values.onboardingId);
    return null;
  });
}

const grantStatusSchema = z.object({
  onboardingId: z.uuid(),
  grantId: z.uuid(),
  status: z.enum(["verified", "declined", "revoked", "requested"]),
});

export async function updateAccessGrant(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("access_grant.update", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(grantStatusSchema, formObject(formData, ["onboardingId", "grantId", "status"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_access_grant", {
      p_grant_id: values.grantId,
      p_status: values.status,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateOnboarding(values.onboardingId);
    return null;
  });
}

const templateSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9-]{2,64}$/),
  name: z.string().trim().min(1).max(200),
  questions: z.string().transform((value, ctx) => {
    try {
      const parsed = z.array(questionSchema).min(1).max(100).safeParse(JSON.parse(value));
      if (parsed.success) return parsed.data;
      ctx.addIssue({ code: "custom", message: parsed.error.issues[0]?.message ?? "Invalid questions." });
    } catch {
      ctx.addIssue({ code: "custom", message: "Questions must be valid JSON." });
    }
    return z.NEVER;
  }),
});

export async function saveQuestionnaire(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("questionnaire.save", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "onboarding.manage");
    const values = parseInput(templateSchema, formObject(formData, ["key", "name", "questions"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_questionnaire_template", {
      p_organization_id: context.organizationId,
      p_key: values.key,
      p_name: values.name,
      p_questions: values.questions,
      p_activate: formData.get("activate") === "on",
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/onboarding/templates");
    return null;
  });
}

/** Onboarding strategist: a draft for the reviewer; it never changes the client's answers. */
export async function runAiReview(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("onboarding.ai_review", async (correlationId) => {
    const { onboardingId } = parseInput(z.object({ onboardingId: z.uuid() }), formObject(formData, ["onboardingId"]));
    const result = await analyzeOnboarding(onboardingId, correlationId);
    if ("error" in result) throw new AppError("PROVIDER_UNAVAILABLE", { message: result.error });
    revalidateOnboarding(onboardingId);
    return null;
  });
}

const noteSchema = z.object({ onboardingId: z.uuid(), noteId: z.uuid(), status: z.enum(["used", "discarded"]) });

export async function setAiNoteStatus(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("onboarding.ai_note_status", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(noteSchema, formObject(formData, ["onboardingId", "noteId", "status"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_onboarding_ai_note_status", {
      p_note_id: values.noteId,
      p_status: values.status,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateOnboarding(values.onboardingId);
    return null;
  });
}
