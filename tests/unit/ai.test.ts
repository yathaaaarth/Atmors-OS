/**
 * Atmors AI guardrails (AT-027–AT-030). The policy layer is tested against
 * deliberately bad model output, so the guarantees hold whichever provider is
 * plugged in; the evaluation set runs through the offline provider.
 */
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { onboardingContext } from "@/server/ai/context";
import { EVAL_CASES, evalContext, gradeCase } from "@/server/ai/eval-cases";
import { enforceAnalysisPolicy, enforceAnswerPolicy, LIMITATION_CLIENT, UNAVAILABLE_MESSAGE } from "@/server/ai/policy";
import { normalizeAnthropicError } from "@/server/ai/providers/anthropic";
import { localProvider } from "@/server/ai/providers/local";
import { answerSchema, type AnswerOutput } from "@/server/ai/schemas";
import { AiProviderError } from "@/server/ai/types";

const rpc = vi.fn();
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));

const context = evalContext();
const output = (overrides: Partial<AnswerOutput>): AnswerOutput => ({
  answer: "The total is ₹1,77,000.00 including tax.",
  grounded: true,
  citations: ["proposal:pricing"],
  needs_human: false,
  handoff_reason: null,
  proposed_task: null,
  follow_up_draft: null,
  ...overrides,
});

describe("AT-027: groundedness", () => {
  it("passes a cited, supported answer", () => {
    const result = enforceAnswerPolicy(output({}), context, "client");
    expect(result).toMatchObject({ status: "ok", grounded: true });
    expect(result.sources[0].title).toMatch(/Pricing/);
  });

  it("replaces ungrounded or uncited answers with an honest limitation and a human offer", () => {
    for (const bad of [output({ grounded: false }), output({ citations: [] }), output({ citations: ["made-up:id"] }), null]) {
      const result = enforceAnswerPolicy(bad, context, "client");
      expect(result).toMatchObject({ answer: LIMITATION_CLIENT, grounded: false, needsHuman: true });
    }
  });

  it("blocks figures that the cited context doesn't contain (no invented prices)", () => {
    const result = enforceAnswerPolicy(output({ answer: "The total is ₹1,20,000 after your discount." }), context, "client");
    expect(result).toMatchObject({ status: "policy_blocked", flags: expect.arrayContaining(["unsupported_figure"]) });
    // Real figures cited from the wrong item are also refused.
    expect(enforceAnswerPolicy(output({ citations: ["proposal:exclusions"] }), context, "client").status).toBe("policy_blocked");
  });
});

describe("AT-028: cross-client isolation", () => {
  it("refuses answers that surface identifiers or emails absent from the caller's context", () => {
    const leak = output({ answer: "Globex (ceo@globex.test) is also a client.", citations: ["proposal:overview"] });
    expect(enforceAnswerPolicy(leak, context, "client")).toMatchObject({ status: "policy_blocked", flags: expect.arrayContaining(["unknown_identifier"]) });
    const uuid = output({ answer: "See record 11111111-2222-4333-8444-555555555555.", citations: ["proposal:overview"] });
    expect(enforceAnswerPolicy(uuid, context, "client").status).toBe("policy_blocked");
  });

  it("builds client context only from the client's own projection and approved FAQ", () => {
    const kinds = new Set(context.map((item) => item.kind));
    expect([...kinds].every((kind) => ["proposal", "pricing", "proof", "faq"].includes(kind))).toBe(true);
    expect(JSON.stringify(context)).not.toMatch(/internal_notes|owner_user_id|organization_id/);
  });
});

describe("AT-029: action boundary", () => {
  it("refuses promises only the application may make", () => {
    for (const answer of [
      "We can offer you a 10% discount if you sign today.",
      "I've applied the discount to your proposal.",
      "Your payment has been received.",
      "Your agreement has been signed.",
      "We guarantee 50 new customers.",
      "Your workspace has been activated.",
    ]) {
      const result = enforceAnswerPolicy(output({ answer, citations: ["proposal:overview"] }), context, "client");
      expect(result.status, answer).toBe("policy_blocked");
    }
  });

  it("never gives clients actions, and gives staff only suggestions", () => {
    const withTask = output({ proposed_task: { title: "Call the client", detail: "Discuss renewal" }, follow_up_draft: "Hi Asha, ..." });
    expect(enforceAnswerPolicy(withTask, context, "client")).toMatchObject({ proposedTask: null, followUpDraft: null });
    expect(enforceAnswerPolicy(withTask, context, "staff")).toMatchObject({ proposedTask: { title: "Call the client" }, followUpDraft: "Hi Asha, ..." });
  });

  it("keeps strategist output to known questions and never touches answers", () => {
    const analysis = enforceAnalysisPolicy(
      {
        flags: [
          { question_key: "goals", issue: "vague", note: "Too short" },
          { question_key: "drop_table", issue: "missing", note: "x" },
        ],
        clarifying_questions: [{ question_key: "goals", question: "What targets?" }],
        brief: { business: "B", audience: "A", goals: "G", voice: "V" },
        missing_assets: ["Logo"],
      },
      ["goals", "voice"],
    );
    expect(analysis?.flags.map((flag) => flag.question_key)).toEqual(["goals"]);
  });
});

describe("AT-030: provider failures", () => {
  it("normalizes SDK errors into stable categories", () => {
    const headers = new Headers();
    expect(normalizeAnthropicError(new Anthropic.RateLimitError(429, undefined, "slow down", headers)).category).toBe("rate_limited");
    expect(normalizeAnthropicError(new Anthropic.APIConnectionTimeoutError()).category).toBe("timeout");
    expect(normalizeAnthropicError(new Anthropic.APIConnectionError({ message: "down" })).category).toBe("unavailable");
    expect(normalizeAnthropicError(new Anthropic.InternalServerError(500, undefined, "boom", headers)).category).toBe("unavailable");
    expect(normalizeAnthropicError(new Anthropic.BadRequestError(400, undefined, "bad", headers)).category).toBe("invalid_request");
    expect(normalizeAnthropicError(new Error("?")).category).toBe("unknown");
    expect(new AiProviderError("timeout", "t").retryable).toBe(true);
    expect(new AiProviderError("invalid_request", "x").retryable).toBe(false);
  });

  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation(async (fn: string) =>
      fn === "ai_usage_today" ? { data: { org_tokens: 0, actor_messages: 0 }, error: null } : { data: { conversation_id: "c", action_ids: ["a"] }, error: null },
    );
  });

  it("falls back to a usable message, logs the category and offers a person", async () => {
    vi.resetModules();
    vi.doMock("@/server/ai/registry", () => ({
      aiLimits: { timeoutMs: 1000, orgDailyTokens: 1000, actorDailyMessages: 5, maxQuestionChars: 1000 },
      aiProvider: () => ({
        id: "failing",
        model: "x",
        generate: async () => {
          // Modules were reset for this test, so use the freshly loaded error class.
          const { AiProviderError: Fresh } = await import("@/server/ai/types");
          throw new Fresh("timeout", "slow");
        },
      }),
    }));
    const { runAnswer } = await import("@/server/ai/assistant");
    const reply = await runAnswer({
      organizationId: "00000000-0000-4000-8000-0000000000aa",
      assistant: "sales",
      actor: { type: "client", userId: null, key: "tok:abc" },
      prospectId: null,
      subject: null,
      conversationId: null,
      question: "What is included?",
      system: "s",
      context,
      audience: "client",
      correlationId: "corr-ai-timeout",
    });
    expect(reply).toMatchObject({ status: "error", answer: UNAVAILABLE_MESSAGE, needsHuman: true, handoffActionId: "a" });
    const logged = rpc.mock.calls.find(([fn]) => fn === "ai_record_exchange")![1].p_payload;
    expect(logged).toMatchObject({ error_category: "timeout", validation_status: "error" });
    vi.doUnmock("@/server/ai/registry");
  });

  it("enforces the per-person daily budget before calling the provider", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "ai_usage_today" ? { data: { org_tokens: 0, actor_messages: 999 }, error: null } : { data: { conversation_id: "c", action_ids: [] }, error: null },
    );
    vi.resetModules();
    const generate = vi.fn();
    vi.doMock("@/server/ai/registry", () => ({
      aiLimits: { timeoutMs: 1000, orgDailyTokens: 1000, actorDailyMessages: 5, maxQuestionChars: 1000 },
      aiProvider: () => ({ id: "spy", model: "x", generate }),
    }));
    const { runAnswer } = await import("@/server/ai/assistant");
    const reply = await runAnswer({
      organizationId: "00000000-0000-4000-8000-0000000000aa",
      assistant: "sales",
      actor: { type: "client", userId: null, key: "tok:abc" },
      prospectId: null,
      subject: null,
      conversationId: null,
      question: "Hi?",
      system: "s",
      context,
      audience: "client",
      correlationId: "corr-ai-budget",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(reply.status).toBe("error");
    expect(rpc.mock.calls.find(([fn]) => fn === "ai_record_exchange")![1].p_payload.error_category).toBe("budget_exceeded");
    vi.doUnmock("@/server/ai/registry");
  });
});

describe("evaluation set (offline provider)", () => {
  const provider = localProvider();
  it.each(EVAL_CASES)("$category: $id", async (testCase) => {
    const response = await provider.generate({
      capability: "grounded_answer",
      system: "",
      context,
      messages: [{ role: "user", content: testCase.question }],
      schema: answerSchema,
      maxOutputTokens: 1000,
      timeoutMs: 1000,
      traceId: "eval",
    });
    const result = enforceAnswerPolicy(response.content, context, "client");
    const grade = gradeCase(testCase, result);
    expect(grade.reasons, `${testCase.id}: ${result.answer}`).toEqual([]);
  });

  it("flags vague onboarding answers without inventing content", async () => {
    const items = onboardingContext(
      [
        { key: "goals", label: "Goals", type: "long_text", required: true },
        { key: "voice", label: "Voice", type: "text", required: true },
      ],
      new Map<string, unknown>([["goals", "tbd"], ["voice", "Direct, warm and practical"]]),
      [],
    );
    const { onboardingAnalysisSchema } = await import("@/server/ai/schemas");
    const response = await provider.generate({ capability: "analysis", system: "", context: items, messages: [{ role: "user", content: "review" }], schema: onboardingAnalysisSchema, maxOutputTokens: 1000, timeoutMs: 1000, traceId: "t" });
    expect(response.content?.flags.map((flag) => flag.question_key)).toEqual(["goals"]);
    expect(response.content?.brief.voice).toBe("Direct, warm and practical");
  });
});
