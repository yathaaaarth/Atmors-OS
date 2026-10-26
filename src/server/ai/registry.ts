import "server-only";

import { anthropicProvider } from "./providers/anthropic";
import { localProvider } from "./providers/local";
import { AiProviderError, type AiProvider } from "./types";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The configured provider (AI_PROVIDER): "anthropic" (Claude), "local" (offline
 * extractive answers, the default) or "disabled". Swapping vendors touches only
 * this file and an adapter (PRD §19).
 */
export function aiProvider(): AiProvider {
  const id = process.env.AI_PROVIDER ?? "local";
  if (id === "anthropic") {
    const effort = (EFFORTS as readonly string[]).includes(process.env.AI_EFFORT ?? "") ? (process.env.AI_EFFORT as (typeof EFFORTS)[number]) : "low";
    return anthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.AI_MODEL ?? "claude-opus-5-5",
      effort,
      fallbacks: process.env.AI_FALLBACKS !== "off",
    });
  }
  if (id === "disabled") {
    return {
      id: "disabled",
      model: "none",
      generate: async () => {
        throw new AiProviderError("unavailable", "AI is disabled by configuration");
      },
    };
  }
  return localProvider();
}

export const aiLimits = {
  timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),
  orgDailyTokens: Number(process.env.AI_ORG_DAILY_TOKENS ?? 500_000),
  actorDailyMessages: Number(process.env.AI_ACTOR_DAILY_MESSAGES ?? 40),
  maxQuestionChars: 1000,
};
