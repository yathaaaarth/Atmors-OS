import type { AnswerOutput, OnboardingAnalysis } from "../schemas";
import type { AiProvider, ContextItem, GenerateRequest, GenerateResponse } from "../types";

/**
 * Offline, deterministic provider used when no AI vendor is configured, and in
 * tests. It answers only by quoting the best-matching approved context and
 * otherwise says it doesn't know, so it can never invent terms. It is
 * intentionally modest; the real value is that the same policy layer and UI
 * run without a vendor.
 */

const STOP = new Set(
  "a an and are as at be but by can do does for from have how i if in is it me my of on or our so that the this to us we what when where which who why will with you your about would could should any there thing things stuff something anything get got".split(" "),
);

const HANDOFF = /\b(talk|speak|call|phone|person|human|someone|representative|contact me)\b/i;
// Pricing decisions belong to a person, never the assistant.
const NEGOTIATION = /\b(discount|cheaper|reduce|reduction|negotiat\w*|lower (?:the )?price|better (?:price|deal)|deal)\b/i;

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9₹]+/g) ?? []).filter((word) => word.length > 2 && !STOP.has(word));
}

function stem(word: string): string {
  return word.replace(/(ings|ing|ies|es|s|ed)$/, "");
}

function bestItems(question: string, context: ContextItem[]): ContextItem[] {
  const wanted = new Set(terms(question).map(stem));
  if (wanted.size === 0) return [];
  return context
    .map((item) => {
      const words = new Set(terms(`${item.title} ${item.text}`).map(stem));
      let score = 0;
      for (const word of wanted) if (words.has(word)) score += 1;
      return { item, score: score / Math.sqrt(wanted.size) };
    })
    .filter((entry) => entry.score >= 0.7)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((entry) => entry.item);
}

function excerpt(item: ContextItem, question: string): string {
  if (item.kind === "pricing") return item.text;
  const wanted = new Set(terms(question).map(stem));
  const sentences = item.text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const relevant = sentences.filter((sentence) => terms(sentence).some((word) => wanted.has(stem(word))));
  return (relevant.length ? relevant : sentences).slice(0, 4).join(" ");
}

function answer(question: string, context: ContextItem[]): AnswerOutput {
  const items = bestItems(question, context);
  const negotiating = NEGOTIATION.test(question);
  const wantsPerson = HANDOFF.test(question) || negotiating;
  if (items.length === 0) {
    return {
      answer: "I don't have approved information that answers that.",
      grounded: false,
      citations: [],
      needs_human: true,
      handoff_reason: wantsPerson ? "Asked to speak to a person" : "Not covered by approved information",
      proposed_task: null,
      follow_up_draft: null,
    };
  }
  return {
    answer: items.map((item) => `${item.title}: ${excerpt(item, question)}`).join("\n\n"),
    grounded: true,
    citations: items.map((item) => item.id),
    needs_human: wantsPerson,
    handoff_reason: negotiating ? "Pricing or terms question for the commercial owner" : wantsPerson ? "Asked to speak to a person" : null,
    proposed_task: null,
    follow_up_draft: null,
  };
}

const VAGUE = /^(n\/?a|na|none|nil|tbd|tbc|not sure|idk|don'?t know|-|\.|\?)$/i;

function analyse(context: ContextItem[]): OnboardingAnalysis {
  const answers = context.filter((item) => item.kind === "answer");
  const flags: OnboardingAnalysis["flags"] = [];
  for (const item of answers) {
    const value = item.text.trim();
    if (VAGUE.test(value) || (value.length < 12 && !/^(yes|no|https?:|\S+@\S+)/i.test(value))) {
      flags.push({ question_key: item.id.replace(/^answer:/, ""), issue: "vague", note: "The answer is very short; a little more detail would help." });
    }
  }
  const get = (key: string) => answers.find((item) => item.id === `answer:${key}`)?.text ?? "";
  return {
    flags,
    clarifying_questions: flags.map((flag) => ({
      question_key: flag.question_key,
      question: `Could you tell us a bit more about "${answers.find((item) => item.id === `answer:${flag.question_key}`)?.title ?? flag.question_key}"?`,
    })),
    brief: {
      business: get("offer_summary") || get("business_name"),
      audience: get("target_audience"),
      goals: get("goals"),
      voice: get("voice"),
    },
    missing_assets: context.some((item) => item.kind === "asset") ? [] : ["Logo and brand guidelines"],
  };
}

export function localProvider(): AiProvider {
  return {
    id: "local",
    model: "extractive-v1",
    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>> {
      const question = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const raw = request.capability === "analysis" ? analyse(request.context) : answer(question, request.context);
      const parsed = request.schema.safeParse(raw);
      return {
        content: parsed.success ? parsed.data : null,
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        provider: "local",
        model: "extractive-v1",
        validation: parsed.success ? "ok" : "invalid",
      };
    },
  };
}
