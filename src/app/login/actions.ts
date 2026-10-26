"use server";

import { publicEnv } from "@/lib/env";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { runAction, type ActionResult } from "@/server/actions/result";
import { AppError, fromZodError } from "@/server/errors";
import { logger } from "@/server/logger";
import { RATE_RULES, assertRateLimit } from "@/server/rate-limit";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { signInSchema } from "./schema";

/**
 * Send a magic sign-in link. Accounts are never created here (signup is
 * invite-only), and the response is identical whether or not the email exists.
 */
export async function requestSignInLink(input: unknown): Promise<ActionResult<{ sent: true }>> {
  return runAction("auth.request_sign_in_link", async (correlationId) => {
    const parsed = signInSchema.safeParse(input);
    if (!parsed.success) throw fromZodError(parsed.error);
    await assertRateLimit(RATE_RULES.signIn);

    const next = safeRedirectPath(parsed.data.next);
    const callback = new URL("/auth/callback", publicEnv().NEXT_PUBLIC_SITE_URL);
    callback.searchParams.set("next", next);

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: parsed.data.email,
      options: { shouldCreateUser: false, emailRedirectTo: callback.toString() },
    });

    if (error) {
      if (error.status === 429) throw new AppError("RATE_LIMITED", { detail: error.message });
      // Unknown users and disabled signups land here; do not reveal which.
      logger.info("auth.sign_in_link_not_sent", { correlation_id: correlationId, status: error.status });
    }
    return { sent: true as const };
  });
}
