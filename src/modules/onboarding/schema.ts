import { z } from "zod";

export const QUESTION_TYPES = [
  "text",
  "long_text",
  "url",
  "email",
  "number",
  "boolean",
  "date",
  "single_choice",
  "multi_choice",
] as const;

export const questionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().min(1).max(300),
  help: z.string().max(500).optional(),
  type: z.enum(QUESTION_TYPES),
  required: z.boolean(),
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
  max_length: z.number().int().positive().optional(),
  show_if: z.object({ question: z.string(), equals: z.union([z.string(), z.boolean(), z.number()]) }).optional(),
});
export type Question = z.infer<typeof questionSchema>;
export type Answers = Record<string, unknown>;

/** Mirror of private.question_visible: follow-ups show only when their condition holds. */
export function isQuestionVisible(question: Question, answers: Answers): boolean {
  if (!question.show_if) return true;
  const value = answers[question.show_if.question];
  return Array.isArray(value) ? value.includes(question.show_if.equals) : value === question.show_if.equals;
}

/** Turn form fields into typed answers. Validation stays authoritative in the database. */
export function answersFromForm(questions: Question[], formData: FormData): Answers {
  const answers: Answers = {};
  for (const question of questions) {
    const name = `q_${question.key}`;
    if (question.type === "multi_choice") {
      const values = formData.getAll(name).filter((value): value is string => typeof value === "string");
      if (values.length) answers[question.key] = values;
      continue;
    }
    const raw = formData.get(name);
    if (typeof raw !== "string" || raw.trim() === "") continue;
    if (question.type === "boolean") answers[question.key] = raw === "yes";
    else if (question.type === "number") {
      const parsed = Number(raw);
      answers[question.key] = Number.isFinite(parsed) ? parsed : raw;
    } else answers[question.key] = raw.trim();
  }
  // Drop hidden follow-ups in question order, as the database does.
  const visible: Answers = {};
  for (const question of questions) {
    if (question.key in answers && isQuestionVisible(question, visible)) visible[question.key] = answers[question.key];
  }
  return visible;
}

export function formatAnswer(question: Question | undefined, value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

const assetSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
});

const grantSchema = z.object({
  id: z.uuid(),
  platform: z.string(),
  requested_scope: z.string(),
  instructions: z.string().nullable(),
  status: z.string(),
  client_note: z.string().nullable(),
});

/** private.client_onboarding_json */
export const clientOnboardingSchema = z.object({
  id: z.uuid(),
  status: z.enum(["not_started", "in_progress", "submitted", "needs_information", "resubmitted", "approved"]),
  questions: z.array(questionSchema),
  draft_answers: z.record(z.string(), z.unknown()),
  info_requests: z.array(z.object({ question_key: z.string().optional().nullable(), message: z.string() })),
  submitted_revision: z.number().nullable(),
  submitted_at: z.string().nullable(),
  submitted_answers: z.record(z.string(), z.unknown()),
  assets: z.array(assetSchema),
  access_grants: z.array(grantSchema),
});
export type ClientOnboarding = z.infer<typeof clientOnboardingSchema>;

/** private.client_workspace_json */
export const clientWorkspaceSchema = z.object({
  id: z.uuid(),
  client_name: z.string(),
  status: z.enum(["setting_up", "active", "suspended", "closed"]),
  delivery_status: z.string(),
  activated_at: z.string().nullable(),
  team: z.array(z.object({ name: z.string().nullable(), role: z.string() })),
  milestones: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      description: z.string().nullable(),
      due_at: z.string().nullable(),
      status: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
  tasks: z.array(z.object({ id: z.uuid(), title: z.string(), description: z.string().nullable(), due_at: z.string().nullable(), status: z.string() })),
  updates: z.array(z.object({ body: z.string(), created_at: z.string() })),
});
export type ClientWorkspace = z.infer<typeof clientWorkspaceSchema>;

export const KICKOFF_BLOCKER_LABELS: Record<string, string> = {
  workspace_not_active: "Workspace not yet active",
  onboarding_not_approved: "Onboarding not yet approved",
  no_delivery_lead: "No delivery lead assigned",
};
