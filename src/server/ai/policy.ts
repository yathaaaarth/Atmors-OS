import type { AnswerOutput, OnboardingAnalysis } from "./schemas";
import type { ContextItem } from "./types";

/**
 * Output policy applied to every answer, whatever the provider (PRD §6).
 * The model is never trusted: citations must point at supplied context,
 * figures must appear in what it cites, and promises the application alone
 * may make (discounts, guarantees, payment or signature confirmations) are
 * refused. Anything that fails falls back to an honest limitation plus an
 * offer of human help (AT-027).
 */

export type Audience = "client" | "staff";

export type PolicyResult = {
  answer: string;
  grounded: boolean;
  sources: { id: string; kind: ContextItem["kind"]; title: string }[];
  needsHuman: boolean;
  handoffReason: string | null;
  status: "ok" | "fallback" | "policy_blocked";
  flags: string[];
  proposedTask: { title: string; detail: string } | null;
  followUpDraft: string | null;
};

export const LIMITATION_CLIENT =
  "I don't have approved information to answer that, so I won't guess. Would you like me to pass your question to your Atmors contact?";
export const LIMITATION_STAFF = "I can't answer that from the records you have access to.";
export const UNAVAILABLE_MESSAGE =
  "The assistant isn't available right now. Your question hasn't been lost: you can ask your Atmors contact directly.";

const FIGURE = /(?:₹|rs\.?\s?|inr\s?|usd\s?|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|lakh|lakhs|crore|k\b)/gi;
const PROMISES: [RegExp, string][] = [
  [/\bguarantee(?:d|s)?\b/i, "guarantee"],
  [/\b(?:i|we)\s+(?:can|will|could|am able to|are able to)\s+(?:offer|give|apply|provide)\s+(?:you\s+)?(?:a|an|the)?\s*(?:\d+%?\s*)?(?:discount|reduction|lower price|special price)/i, "discount_offer"],
  [/\b(?:i|we)\s*(?:'ve|have)\s+(?:applied|approved|changed|updated|reduced)\b/i, "claimed_change"],
  [/\byour\s+(?:payment|signature|agreement|contract)\s+(?:has been|was|is now)\s+(?:received|confirmed|completed|signed|processed|executed)/i, "claimed_state"],
  [/\b(?:workspace|account)\s+(?:has been|is now)\s+(?:activated|active)/i, "claimed_activation"],
];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;

const digits = (value: string) => value.replace(/[^\d.]/g, "").replace(/\.0+$/, "").replace(/\.$/, "");

function figuresSupported(answer: string, cited: ContextItem[]): boolean {
  const haystack = cited.map((item) => item.text).join(" ");
  const available = new Set((haystack.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(digits));
  return (answer.match(FIGURE) ?? []).every((figure) => available.has(digits(figure)));
}

/** Identifiers and emails in the answer must already be in the authorized context (AT-028, defence in depth). */
function leaksIdentifiers(answer: string, context: ContextItem[]): boolean {
  const known = context.map((item) => `${item.id} ${item.title} ${item.text}`).join(" ").toLowerCase();
  return [...(answer.match(UUID) ?? []), ...(answer.match(EMAIL) ?? [])].some((token) => !known.includes(token.toLowerCase()));
}

function limitation(audience: Audience, flags: string[], status: PolicyResult["status"], reason: string | null, raw?: AnswerOutput | null): PolicyResult {
  return {
    answer: audience === "client" ? LIMITATION_CLIENT : LIMITATION_STAFF,
    grounded: false,
    sources: [],
    needsHuman: audience === "client",
    handoffReason: reason ?? raw?.handoff_reason ?? "Not covered by approved information",
    status,
    flags,
    proposedTask: null,
    followUpDraft: null,
  };
}

export function enforceAnswerPolicy(raw: AnswerOutput | null, context: ContextItem[], audience: Audience): PolicyResult {
  if (!raw) return limitation(audience, ["no_valid_output"], "fallback", null);
  const flags: string[] = [];
  const byId = new Map(context.map((item) => [item.id, item]));
  const cited = [...new Set(raw.citations)].map((id) => byId.get(id)).filter((item): item is ContextItem => Boolean(item));
  if (cited.length < raw.citations.length) flags.push("unknown_citation");
  const text = raw.answer.trim().slice(0, 4000);

  if (!raw.grounded || cited.length === 0 || text.length === 0) {
    return limitation(audience, [...flags, "ungrounded"], "fallback", raw.handoff_reason, raw);
  }
  if (!figuresSupported(text, cited)) return limitation(audience, [...flags, "unsupported_figure"], "policy_blocked", null, raw);
  if (leaksIdentifiers(text, context)) return limitation(audience, [...flags, "unknown_identifier"], "policy_blocked", null, raw);
  if (audience === "client") {
    const promise = PROMISES.find(([pattern]) => pattern.test(text));
    if (promise) return limitation(audience, [...flags, `promise:${promise[1]}`], "policy_blocked", null, raw);
  }

  return {
    answer: text,
    grounded: true,
    sources: cited.map((item) => ({ id: item.id, kind: item.kind, title: item.title })),
    needsHuman: raw.needs_human,
    handoffReason: raw.needs_human ? (raw.handoff_reason ?? "Asked for a person") : null,
    status: "ok",
    flags,
    // Staff-only suggestions; clients never get actions beyond a handoff.
    proposedTask:
      audience === "staff" && raw.proposed_task && raw.proposed_task.title.trim().length >= 3
        ? { title: raw.proposed_task.title.trim().slice(0, 200), detail: raw.proposed_task.detail.trim().slice(0, 2000) }
        : null,
    followUpDraft: audience === "staff" && raw.follow_up_draft ? raw.follow_up_draft.trim().slice(0, 4000) : null,
  };
}

/** Keep strategist output to known questions and bounded text; it is a draft for a person. */
export function enforceAnalysisPolicy(raw: OnboardingAnalysis | null, questionKeys: string[]): OnboardingAnalysis | null {
  if (!raw) return null;
  const known = new Set(questionKeys);
  const clip = (value: string, max: number) => value.trim().slice(0, max);
  return {
    flags: raw.flags.filter((flag) => known.has(flag.question_key)).slice(0, 30).map((flag) => ({ ...flag, note: clip(flag.note, 500) })),
    clarifying_questions: raw.clarifying_questions
      .filter((item) => item.question_key === null || known.has(item.question_key))
      .slice(0, 20)
      .map((item) => ({ ...item, question: clip(item.question, 500) })),
    brief: {
      business: clip(raw.brief.business, 1500),
      audience: clip(raw.brief.audience, 1500),
      goals: clip(raw.brief.goals, 1500),
      voice: clip(raw.brief.voice, 600),
    },
    missing_assets: raw.missing_assets.slice(0, 15).map((item) => clip(item, 200)),
  };
}
