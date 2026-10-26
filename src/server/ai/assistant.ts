import "server-only";

import { z } from "zod";

import { questionSchema } from "@/modules/onboarding/schema";
import { clientProposalSchema, invitationViewSchema, type ClientProposal } from "@/modules/proposals/client-view";
import { formatMoney } from "@/modules/proposals/money";
import { requireSessionUser } from "@/server/auth/session";
import { requireMemberContext } from "@/server/authorization/member-context";
import { assertCan } from "@/server/authorization/permissions";
import { AppError, fromPostgrestError } from "@/server/errors";
import { logger } from "@/server/logger";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { Json } from "@/server/supabase/database.types";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { onboardingContext, proposalContext } from "./context";
import { enforceAnalysisPolicy, enforceAnswerPolicy, UNAVAILABLE_MESSAGE, type Audience, type PolicyResult } from "./policy";
import { COPILOT_SYSTEM, SALES_ASSISTANT_SYSTEM, STRATEGIST_SYSTEM } from "./prompts";
import { aiLimits, aiProvider } from "./registry";
import { answerSchema, onboardingAnalysisSchema, type OnboardingAnalysis } from "./schemas";
import { AiProviderError, type ContextItem } from "./types";

export type AssistantReply = {
  conversationId: string | null;
  answer: string;
  grounded: boolean;
  sources: { kind: string; title: string }[];
  needsHuman: boolean;
  status: PolicyResult["status"] | "error";
  handoffActionId: string | null;
  taskActionId: string | null;
  proposedTask: PolicyResult["proposedTask"];
  followUpDraft: string | null;
  provider: string;
};

type Actor = { type: "user" | "client"; userId: string | null; key: string };

const questionInput = z.string().trim().min(2, "Ask a question.").max(aiLimits.maxQuestionChars);

/**
 * The PRD §6 pipeline: (caller already authorized and context selected) ->
 * budget check -> provider -> output validation -> policy -> proposed actions
 * -> audit of outcome and usage. Provider failures become a normalized,
 * logged fallback instead of an error page (AT-030).
 */
export async function runAnswer(input: {
  organizationId: string;
  assistant: "sales" | "copilot";
  actor: Actor;
  prospectId: string | null;
  subject: { type: "proposal" | "prospect"; id: string } | null;
  conversationId: string | null;
  question: string;
  system: string;
  context: ContextItem[];
  audience: Audience;
  correlationId: string;
}): Promise<AssistantReply> {
  const admin = createSupabaseAdminClient();
  const provider = aiProvider();
  const started = Date.now();
  let policy: PolicyResult;
  let meta: { input_tokens?: number; output_tokens?: number; finish_reason?: string; model: string; error_category?: string } = { model: provider.model };
  let status: AssistantReply["status"];

  const { data: usage } = await admin.rpc("ai_usage_today", { p_organization_id: input.organizationId, p_actor_key: input.actor.key });
  const counts = (usage ?? {}) as { org_tokens?: number; actor_messages?: number };
  if ((counts.org_tokens ?? 0) >= aiLimits.orgDailyTokens || (counts.actor_messages ?? 0) >= aiLimits.actorDailyMessages) {
    policy = { ...enforceAnswerPolicy(null, [], input.audience), answer: "You've reached today's limit for the assistant. A person can still help." };
    meta = { ...meta, error_category: "budget_exceeded" };
    status = "error";
  } else {
    try {
      const response = await provider.generate({
        capability: "grounded_answer",
        system: input.system,
        context: input.context,
        messages: [{ role: "user", content: input.question }],
        schema: answerSchema,
        maxOutputTokens: 4000,
        timeoutMs: aiLimits.timeoutMs,
        traceId: input.correlationId,
      });
      meta = { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens, finish_reason: response.finishReason, model: response.model };
      policy = enforceAnswerPolicy(response.content, input.context, input.audience);
      if (response.validation === "refused") policy.flags.push("provider_refused");
      status = policy.status;
    } catch (error) {
      const category = error instanceof AiProviderError ? error.category : "unknown";
      logger.warn("ai.provider_error", { correlation_id: input.correlationId, provider: provider.id, category });
      policy = { ...enforceAnswerPolicy(null, [], input.audience), answer: UNAVAILABLE_MESSAGE };
      meta = { ...meta, error_category: category };
      status = "error";
    }
  }

  const actions: { tool_name: string; arguments: Record<string, unknown> }[] = [];
  if (input.audience === "client" && policy.needsHuman) {
    actions.push({ tool_name: "request_human_help", arguments: { reason: policy.handoffReason, question: input.question } });
  }
  if (policy.proposedTask) actions.push({ tool_name: "propose_task", arguments: policy.proposedTask });
  if (policy.followUpDraft) actions.push({ tool_name: "draft_follow_up", arguments: { draft: policy.followUpDraft } });

  const { data: logged, error: logError } = await admin.rpc("ai_record_exchange", {
    p_payload: {
      conversation_id: input.conversationId ?? "",
      organization_id: input.organizationId,
      assistant: input.assistant,
      actor_type: input.actor.type,
      actor_user_id: input.actor.userId ?? "",
      actor_key: input.actor.key,
      prospect_id: input.prospectId ?? "",
      subject_type: input.subject?.type ?? "",
      subject_id: input.subject?.id ?? "",
      question: input.question,
      answer: policy.answer,
      grounded: policy.grounded,
      sources: policy.sources,
      provider: provider.id,
      model: meta.model,
      input_tokens: meta.input_tokens ?? null,
      output_tokens: meta.output_tokens ?? null,
      latency_ms: Date.now() - started,
      finish_reason: meta.finish_reason ?? null,
      validation_status: status,
      policy_flags: policy.flags,
      error_category: meta.error_category ?? "",
      correlation_id: input.correlationId,
      actions,
    } as Json,
  });
  if (logError) logger.error("ai.log_failed", { correlation_id: input.correlationId, code: logError.code });
  const record = (logged ?? {}) as { conversation_id?: string; action_ids?: string[] };
  const actionId = (tool: string) => {
    const index = actions.findIndex((action) => action.tool_name === tool);
    return index >= 0 ? (record.action_ids?.[index] ?? null) : null;
  };

  return {
    conversationId: record.conversation_id ?? null,
    answer: policy.answer,
    grounded: policy.grounded,
    sources: policy.sources.map(({ kind, title }) => ({ kind, title })),
    needsHuman: policy.needsHuman,
    status,
    handoffActionId: actionId("request_human_help"),
    taskActionId: actionId("propose_task"),
    proposedTask: policy.proposedTask,
    followUpDraft: policy.followUpDraft,
    provider: provider.id,
  };
}

export type SalesScope = { kind: "token"; tokenHash: string } | { kind: "client"; proposalId: string };

/** Load exactly what the caller may see about their proposal, plus approved FAQ. */
async function salesContext(scope: SalesScope): Promise<{ view: ClientProposal; organizationId: string; prospectId: string; actor: Actor }> {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (scope.kind === "token") {
    const { data, error } = await supabase.rpc("invitation_view", { p_token_hash: scope.tokenHash });
    if (error) throw fromPostgrestError(error);
    const view = invitationViewSchema.parse(data);
    if (view.state !== "valid" || !view.proposal) throw new AppError("INVITATION_EXPIRED", { message: "This link can't be used for questions." });
    const { data: invitation } = await admin.from("invitations").select("organization_id, prospect_id").eq("token_hash", scope.tokenHash).single();
    return {
      view: view.proposal,
      organizationId: invitation!.organization_id,
      prospectId: invitation!.prospect_id,
      actor: { type: "client", userId: null, key: `tok:${scope.tokenHash.slice(0, 24)}` },
    };
  }
  const user = await requireSessionUser();
  const { data, error } = await supabase.rpc("client_proposal_view", { p_proposal_id: scope.proposalId });
  if (error) throw fromPostgrestError(error);
  const view = clientProposalSchema.parse(data);
  const { data: proposal } = await admin.from("proposals").select("organization_id, prospect_id").eq("id", scope.proposalId).single();
  return { view, organizationId: proposal!.organization_id, prospectId: proposal!.prospect_id, actor: { type: "client", userId: user.id, key: `user:${user.id}` } };
}

export async function askSalesAssistant(scope: SalesScope, rawQuestion: string, conversationId: string | null, correlationId: string) {
  const question = questionInput.parse(rawQuestion);
  const { view, organizationId, prospectId, actor } = await salesContext(scope);
  const supabase = await createSupabaseServerClient();
  const { data: faq } = await supabase.rpc("client_knowledge", scope.kind === "token" ? { p_token_hash: scope.tokenHash } : {});
  const context = proposalContext(view, (faq ?? []) as { id: string; title: string; body: string }[]);
  return runAnswer({
    organizationId,
    assistant: "sales",
    actor,
    prospectId,
    subject: { type: "proposal", id: view.proposal.id },
    conversationId,
    question,
    system: SALES_ASSISTANT_SYSTEM,
    context,
    audience: "client",
    correlationId,
  });
}

/** The client confirms the handoff; only then is their question passed to a person. */
export async function confirmSalesHandoff(scope: SalesScope, actionId: string, correlationId: string): Promise<void> {
  const { actor } = await salesContext(scope);
  const admin = createSupabaseAdminClient();
  const { data: event, error } = await admin
    .from("ai_tool_events")
    .select("id, tool_name, proposed_arguments, human_confirmation, ai_conversations!inner(actor_key)")
    .eq("id", actionId)
    .eq("ai_conversations.actor_key", actor.key)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!event || event.tool_name !== "request_human_help" || event.human_confirmation !== "pending") throw new AppError("NOT_FOUND");
  const args = event.proposed_arguments as { question?: string; reason?: string };
  const message = `Asked via the proposal assistant: ${args.question ?? ""}`.slice(0, 2000);

  const supabase = await createSupabaseServerClient();
  const { error: helpError } =
    scope.kind === "token"
      ? await supabase.rpc("request_invitation_help", { p_token_hash: scope.tokenHash, p_kind: "question", p_message: message, p_correlation_id: correlationId })
      : await supabase.rpc("client_request_callback", {
          p_prospect_id: null as unknown as string,
          p_purpose: "commercial",
          p_message: message,
          p_idempotency_key: `ai-handoff-${actionId}`,
          p_correlation_id: correlationId,
        });
  if (helpError) throw fromPostgrestError(helpError);
  await admin.rpc("ai_resolve_action", {
    p_event_id: actionId,
    p_actor_key: actor.key,
    p_decision: "confirmed",
    p_result: { handed_off: true },
    p_confirmed_by: (actor.userId ?? null) as unknown as string,
  });
}

/**
 * Read-only copilot. Context comes from the member's own RLS-bound queries, so
 * it respects the same record-level permissions they have (PRD §6).
 */
export async function askCopilot(prospectId: string, rawQuestion: string, conversationId: string | null, correlationId: string) {
  const context = await requireMemberContext();
  assertCan(context, "ai.copilot");
  const question = questionInput.parse(rawQuestion);
  const supabase = await createSupabaseServerClient();
  const { data: prospect } = await supabase
    .from("prospects")
    .select("id, name, company, status, next_action_at, notes, target_service, source")
    .eq("id", prospectId)
    .maybeSingle();
  if (!prospect) throw new AppError("NOT_FOUND");

  const [outreach, proposals, meetings, contracts, invoices, workspaces, tasks, sops] = await Promise.all([
    supabase.from("outreach_events").select("id, channel, direction, event_type, summary, occurred_at").eq("prospect_id", prospectId).order("occurred_at", { ascending: false }).limit(10),
    supabase.from("proposals").select("id, title, status, sent_at, accepted_at").eq("prospect_id", prospectId),
    supabase.from("meetings").select("id, purpose, status, start_at").eq("prospect_id", prospectId).order("start_at", { ascending: false }).limit(5),
    supabase.from("contracts").select("id, title, status, executed_at, activation_eligible").eq("prospect_id", prospectId),
    supabase.from("invoices").select("id, invoice_number, status, balance_minor, currency, due_at").eq("prospect_id", prospectId),
    supabase.from("workspaces").select("id, status, delivery_status, blocked_reasons, kickoff_blockers").eq("prospect_id", prospectId),
    supabase.from("ops_tasks").select("id, title, due_at, kind").eq("prospect_id", prospectId).eq("status", "open").limit(20),
    supabase.from("knowledge_documents").select("id, title, body").eq("organization_id", context.organizationId).eq("audience", "internal").eq("status", "approved").limit(20),
  ]);

  const date = (value: string | null) => (value ? value.slice(0, 10) : "not set");
  const items: ContextItem[] = [
    {
      id: `prospect:${prospect.id}`,
      kind: "record",
      title: `${prospect.name}${prospect.company ? ` (${prospect.company})` : ""}`,
      text: `Status ${prospect.status}; next action ${date(prospect.next_action_at)}; service ${prospect.target_service ?? "n/a"}; source ${prospect.source ?? "n/a"}.\nNotes: ${prospect.notes ?? "none"}`,
    },
  ];
  if (outreach.data?.length) items.push({ id: "outreach", kind: "record", title: "Recent outreach", text: outreach.data.map((row) => `- ${date(row.occurred_at)} ${row.direction} ${row.channel} ${row.event_type}: ${row.summary ?? ""}`).join("\n") });
  for (const row of proposals.data ?? []) items.push({ id: `proposal:${row.id}`, kind: "record", title: `Proposal: ${row.title}`, text: `Status ${row.status}; sent ${date(row.sent_at)}; accepted ${date(row.accepted_at)}.` });
  if (meetings.data?.length) items.push({ id: "meetings", kind: "record", title: "Meetings", text: meetings.data.map((row) => `- ${row.start_at.slice(0, 16).replace("T", " ")} UTC ${row.purpose} (${row.status})`).join("\n") });
  for (const row of contracts.data ?? []) items.push({ id: `contract:${row.id}`, kind: "record", title: `Agreement: ${row.title}`, text: `Status ${row.status}; executed ${date(row.executed_at)}; activation ${row.activation_eligible ? "eligible" : "not eligible"}.` });
  for (const row of invoices.data ?? []) items.push({ id: `invoice:${row.id}`, kind: "record", title: `Invoice ${row.invoice_number}`, text: `Status ${row.status}; balance ${formatMoney(row.balance_minor, row.currency)}; due ${date(row.due_at)}.` });
  for (const row of workspaces.data ?? []) items.push({ id: `workspace:${row.id}`, kind: "record", title: "Workspace", text: `Status ${row.status}; delivery ${row.delivery_status}; blocked by ${row.blocked_reasons.join(", ") || "nothing"}; kickoff blockers ${row.kickoff_blockers.join(", ") || "none"}.` });
  if (tasks.data?.length) items.push({ id: "tasks", kind: "record", title: "Open internal tasks", text: tasks.data.map((row) => `- ${row.title} (due ${date(row.due_at)})`).join("\n") });
  for (const doc of sops.data ?? []) items.push({ id: `sop:${doc.id}`, kind: "sop", title: doc.title, text: doc.body });

  return runAnswer({
    organizationId: context.organizationId,
    assistant: "copilot",
    actor: { type: "user", userId: context.userId, key: `user:${context.userId}` },
    prospectId,
    subject: { type: "prospect", id: prospectId },
    conversationId,
    question,
    system: COPILOT_SYSTEM,
    context: items,
    audience: "staff",
    correlationId,
  });
}

/** Confirming a copilot-proposed task re-checks the member's permission at execution time (PRD §9). */
export async function confirmCopilotTask(actionId: string, correlationId: string): Promise<void> {
  const context = await requireMemberContext();
  const supabase = await createSupabaseServerClient();
  const { data: event, error } = await supabase
    .from("ai_tool_events")
    .select("id, tool_name, proposed_arguments, human_confirmation, ai_conversations!inner(prospect_id, actor_user_id)")
    .eq("id", actionId)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!event || event.tool_name !== "propose_task" || event.human_confirmation !== "pending" || event.ai_conversations.actor_user_id !== context.userId) {
    throw new AppError("NOT_FOUND");
  }
  const args = event.proposed_arguments as { title: string; detail: string };
  const { data: taskId, error: taskError } = await supabase.rpc("create_ops_task_for_prospect", {
    p_prospect_id: event.ai_conversations.prospect_id!,
    p_title: args.title,
    p_detail: args.detail,
    p_correlation_id: correlationId,
  });
  if (taskError) throw fromPostgrestError(taskError);
  await createSupabaseAdminClient().rpc("ai_resolve_action", {
    p_event_id: actionId,
    p_actor_key: `user:${context.userId}`,
    p_decision: "confirmed",
    p_result: { task_id: taskId },
    p_confirmed_by: context.userId,
  });
}

/**
 * Onboarding strategist: flags and draft questions for the reviewer, stored
 * as a draft note. It reads answers; it can never write them (AT-021).
 */
export async function analyzeOnboarding(onboardingId: string, correlationId: string): Promise<{ noteId: string } | { error: string }> {
  const context = await requireMemberContext();
  assertCan(context, "onboarding.manage");
  const supabase = await createSupabaseServerClient();
  const { data: onboarding } = await supabase
    .from("onboardings")
    .select("id, prospect_id, current_submission_id, questionnaire_templates(questions)")
    .eq("id", onboardingId)
    .maybeSingle();
  if (!onboarding?.current_submission_id) throw new AppError("INVALID_STATE_TRANSITION", { message: "Nothing has been submitted yet." });
  const [{ data: answers }, { data: assets }] = await Promise.all([
    supabase.from("onboarding_answers").select("question_key, answer_json").eq("submission_id", onboarding.current_submission_id),
    supabase.from("client_assets").select("filename").eq("prospect_id", onboarding.prospect_id).eq("status", "ready"),
  ]);
  const questions = questionSchema.array().parse(onboarding.questionnaire_templates?.questions ?? []);
  const items = onboardingContext(questions, new Map((answers ?? []).map((row) => [row.question_key, row.answer_json])), (assets ?? []).map((row) => row.filename));

  const provider = aiProvider();
  let analysis: OnboardingAnalysis | null = null;
  let category: string | null = null;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let model = provider.model;
  try {
    const response = await provider.generate({
      capability: "analysis",
      system: STRATEGIST_SYSTEM,
      context: items,
      messages: [{ role: "user", content: "Review these onboarding answers." }],
      schema: onboardingAnalysisSchema,
      maxOutputTokens: 6000,
      timeoutMs: aiLimits.timeoutMs,
      traceId: correlationId,
    });
    analysis = enforceAnalysisPolicy(response.content, questions.map((question) => question.key));
    usage = response.usage;
    model = response.model;
  } catch (error) {
    category = error instanceof AiProviderError ? error.category : "unknown";
  }

  await createSupabaseAdminClient().rpc("ai_record_exchange", {
    p_payload: {
      organization_id: context.organizationId,
      assistant: "onboarding",
      actor_type: "user",
      actor_user_id: context.userId,
      actor_key: `user:${context.userId}`,
      prospect_id: onboarding.prospect_id,
      subject_type: "onboarding",
      subject_id: onboarding.id,
      question: "Review the latest onboarding submission.",
      answer: analysis ? `${analysis.flags.length} flags, ${analysis.clarifying_questions.length} draft questions` : UNAVAILABLE_MESSAGE,
      grounded: Boolean(analysis),
      provider: provider.id,
      model,
      input_tokens: usage.inputTokens ?? null,
      output_tokens: usage.outputTokens ?? null,
      validation_status: analysis ? "ok" : category ? "error" : "fallback",
      error_category: category ?? "",
      correlation_id: correlationId,
    } as Json,
  });
  if (!analysis) return { error: category ? UNAVAILABLE_MESSAGE : "The assistant couldn't produce a usable review this time." };

  const { data: note, error } = await supabase.rpc("save_onboarding_ai_note", {
    p_onboarding_id: onboarding.id,
    p_submission_id: onboarding.current_submission_id,
    p_content: analysis as unknown as Json,
    p_provider: provider.id,
    p_model: model,
    p_correlation_id: correlationId,
  });
  if (error) throw fromPostgrestError(error);
  return { noteId: note.id };
}

