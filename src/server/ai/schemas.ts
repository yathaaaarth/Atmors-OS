import { z } from "zod";

/** Structured answer for the sales assistant and the internal copilot. */
export const answerSchema = z.object({
  answer: z.string(),
  /** True only when every factual statement comes from the cited context items. */
  grounded: z.boolean(),
  /** IDs of the context items the answer relies on. */
  citations: z.array(z.string()),
  needs_human: z.boolean(),
  handoff_reason: z.string().nullable(),
  /** Copilot only: an internal task to propose (never created without confirmation). */
  proposed_task: z.object({ title: z.string(), detail: z.string() }).nullable(),
  /** Copilot only: a draft message for a person to review and send themselves. */
  follow_up_draft: z.string().nullable(),
});
export type AnswerOutput = z.infer<typeof answerSchema>;

/** Onboarding strategist output, stored as a draft note apart from the answers. */
export const onboardingAnalysisSchema = z.object({
  flags: z.array(
    z.object({
      question_key: z.string(),
      issue: z.enum(["missing", "vague", "contradictory"]),
      note: z.string(),
    }),
  ),
  clarifying_questions: z.array(z.object({ question_key: z.string().nullable(), question: z.string() })),
  brief: z.object({ business: z.string(), audience: z.string(), goals: z.string(), voice: z.string() }),
  missing_assets: z.array(z.string()),
});
export type OnboardingAnalysis = z.infer<typeof onboardingAnalysisSchema>;
