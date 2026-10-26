import Anthropic from "@anthropic-ai/sdk";

import { toProviderJsonSchema } from "../json-schema";
import { AiProviderError, renderContext, type AiProvider, type GenerateRequest, type GenerateResponse } from "../types";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicConfig = {
  apiKey?: string;
  model: string;
  effort: Effort;
  /** Server-side refusal fallback (beta). On by default; set AI_FALLBACKS=off to disable. */
  fallbacks: boolean;
};

export function normalizeAnthropicError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof Anthropic.RateLimitError) return new AiProviderError("rate_limited", "provider rate limit", { cause: error });
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new AiProviderError("timeout", "provider timeout", { cause: error });
  if (error instanceof Anthropic.APIConnectionError) return new AiProviderError("unavailable", "provider unreachable", { cause: error });
  if (error instanceof Anthropic.InternalServerError) return new AiProviderError("unavailable", "provider error", { cause: error });
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError("unavailable", "provider credentials rejected", { cause: error });
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new AiProviderError("invalid_request", "provider rejected the request", { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new AiProviderError(error.status === 529 ? "unavailable" : "unknown", `provider status ${error.status}`, { cause: error });
  }
  return new AiProviderError("unknown", "provider failure", { cause: error });
}

/**
 * Claude adapter. Structured output via output_config.format (JSON schema),
 * validated again with Zod; refusals are handled before reading content; the
 * SDK retries transient failures once (bounded retry) within the timeout.
 */
export function anthropicProvider(config: AnthropicConfig): AiProvider {
  const client = new Anthropic({ ...(config.apiKey ? { apiKey: config.apiKey } : {}), maxRetries: 1 });

  return {
    id: "anthropic",
    model: config.model,

    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>> {
      const [first, ...rest] = request.messages;
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        { role: "user", content: `${renderContext(request.context)}\n\n${first?.content ?? ""}` },
        ...rest.map((message) => ({ role: message.role, content: message.content })),
      ];
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create(
          {
            model: config.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages,
            output_config: { effort: config.effort, format: { type: "json_schema", schema: toProviderJsonSchema(request.schema) } },
            ...(config.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { timeout: request.timeoutMs },
        );
      } catch (error) {
        throw normalizeAnthropicError(error);
      }

      const base = {
        finishReason: response.stop_reason ?? "unknown",
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        provider: "anthropic",
        model: response.model,
      };
      if (response.stop_reason === "refusal") return { ...base, content: null, validation: "refused" };

      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      try {
        const parsed = request.schema.safeParse(JSON.parse(text));
        return parsed.success ? { ...base, content: parsed.data, validation: "ok" } : { ...base, content: null, validation: "invalid" };
      } catch {
        return { ...base, content: null, validation: "invalid" };
      }
    },
  };
}
