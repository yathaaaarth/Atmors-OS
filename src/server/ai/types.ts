import type { z } from "zod";

/**
 * Provider-independent AI contract (PRD §6): generate(request) -> response.
 * Business modules never import a vendor SDK; adapters normalize errors into
 * these categories so callers can fall back predictably (AT-030).
 */

export type AiErrorCategory = "rate_limited" | "timeout" | "unavailable" | "invalid_request" | "policy_blocked" | "unknown";

export class AiProviderError extends Error {
  readonly category: AiErrorCategory;
  readonly retryable: boolean;

  constructor(category: AiErrorCategory, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.category = category;
    this.retryable = category === "rate_limited" || category === "timeout" || category === "unavailable";
  }
}

/** One authorized, approved piece of context. Its text is data, never instructions. */
export type ContextItem = {
  id: string;
  kind: "proposal" | "pricing" | "proof" | "faq" | "sop" | "record" | "answer" | "asset";
  title: string;
  text: string;
};

export type AiMessage = { role: "user" | "assistant"; content: string };

export type GenerateRequest<T> = {
  /** grounded_answer: Q&A over context; analysis: structured review of submitted material. */
  capability: "grounded_answer" | "analysis";
  system: string;
  context: ContextItem[];
  messages: AiMessage[];
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  timeoutMs: number;
  traceId: string;
};

export type GenerateResponse<T> = {
  /** Parsed, schema-valid content, or null when the output was refused or invalid. */
  content: T | null;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number };
  provider: string;
  model: string;
  validation: "ok" | "invalid" | "refused";
};

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>>;
}

/** Render context as clearly delimited data for the model. */
export function renderContext(items: ContextItem[]): string {
  if (items.length === 0) return "<context>\n(no approved information available)\n</context>";
  const escape = (value: string) => value.replaceAll("<", "‹").replaceAll(">", "›");
  return [
    "<context>",
    ...items.map((item) => `<item id="${item.id}" kind="${item.kind}" title="${escape(item.title)}">\n${escape(item.text)}\n</item>`),
    "</context>",
  ].join("\n");
}
