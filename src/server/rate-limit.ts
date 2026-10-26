import "server-only";

import { createHash } from "node:crypto";

import { headers } from "next/headers";

import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/** Client IP from the hosting proxy, hashed so raw addresses are never stored. */
export async function clientIpKey(source?: Headers): Promise<string> {
  const list = source ?? (await headers());
  const ip = list.get("x-forwarded-for")?.split(",")[0]?.trim() || list.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`clientos:${ip}`).digest("hex").slice(0, 32);
}

export type RateRule = { bucket: string; limit: number; windowSeconds: number };

/** Shared limits for public and expensive endpoints (fixed windows, enforced in Postgres). */
export const RATE_RULES = {
  signIn: { bucket: "sign_in", limit: 10, windowSeconds: 600 },
  publicForm: { bucket: "public_form", limit: 20, windowSeconds: 600 },
  booking: { bucket: "booking", limit: 30, windowSeconds: 600 },
  assistant: { bucket: "assistant", limit: 20, windowSeconds: 300 },
  upload: { bucket: "upload", limit: 30, windowSeconds: 600 },
  webhook: { bucket: "webhook", limit: 300, windowSeconds: 60 },
} satisfies Record<string, RateRule>;

/**
 * Throw RATE_LIMITED when the caller exceeded the rule. Keyed by IP hash, plus
 * a subject (user or token) when given. If the limiter itself is unavailable
 * the request is allowed and logged: availability over strictness, with
 * edge limits (D-009) as the outer layer.
 */
export async function assertRateLimit(rule: RateRule, subject?: string, source?: Headers): Promise<void> {
  const key = `${rule.bucket}:${subject ?? (await clientIpKey(source))}`;
  try {
    const { data, error } = await createSupabaseAdminClient().rpc("rate_limit_hit", {
      p_key: key,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });
    if (error) throw error;
    if (data === false) throw new AppError("RATE_LIMITED");
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.warn("rate_limit.unavailable", { bucket: rule.bucket });
  }
}
