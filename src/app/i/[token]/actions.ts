"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { publicEnv } from "@/lib/env";
import { hashInvitationToken, isPlausibleInvitationToken } from "@/modules/crm/invitation-token";
import { formObject } from "@/server/actions/form-data";
import { runAction, type ActionResult } from "@/server/actions/result";
import { getSessionUser } from "@/server/auth/session";
import { AppError, fromPostgrestError, fromZodError } from "@/server/errors";
import { INVITE_COOKIE, INVITE_COOKIE_OPTIONS } from "@/server/invitations";
import { logger } from "@/server/logger";
import { RATE_RULES, assertRateLimit } from "@/server/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

function tokenHashOrThrow(token: unknown): { token: string; tokenHash: string } {
  if (typeof token !== "string" || !isPlausibleInvitationToken(token)) {
    throw new AppError("INVITATION_EXPIRED", { message: "This link is not valid." });
  }
  return { token, tokenHash: hashInvitationToken(token) };
}

/**
 * Possessing the link lets someone read the proposal; accepting it requires
 * proving control of the invited email (PRD §11, AT-004). This emails a
 * single-use sign-in link to the address the invitation is bound to.
 */
export async function beginInvitationSignIn(_: unknown, formData: FormData): Promise<ActionResult<{ sentTo: string }>> {
  let redirectTo: string | null = null;
  const result = await runAction("invitation.begin_sign_in", async (correlationId) => {
    const { token, tokenHash } = tokenHashOrThrow(formData.get("token"));
    await assertRateLimit(RATE_RULES.signIn);
    const user = await getSessionUser();
    const supabase = await createSupabaseServerClient();

    if (user) {
      // Already signed in: bind directly (the RPC checks the email matches).
      const { data, error } = await supabase.rpc("redeem_invitation", {
        p_token_hash: tokenHash,
        p_correlation_id: correlationId,
      });
      if (error) {
        const appError = fromPostgrestError(error);
        if (appError.code === "FORBIDDEN") {
          throw new AppError("FORBIDDEN", {
            message: "You're signed in with a different email than this invitation was sent to. Sign out and try again.",
          });
        }
        throw appError;
      }
      redirectTo = data ? `/portal/proposals/${data}` : "/portal";
      return { sentTo: "" };
    }

    const admin = createSupabaseAdminClient();
    const { data: email, error: contactError } = await admin.rpc("invitation_contact", { p_token_hash: tokenHash });
    if (contactError) throw fromPostgrestError(contactError);
    if (!email) throw new AppError("INVITATION_EXPIRED");

    // Provision the invited contact's account if needed (public signup is off).
    const { error: createError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createError && createError.code !== "email_exists") {
      logger.error("invitation.provision_failed", { correlation_id: correlationId, code: createError.code });
      throw new AppError("PROVIDER_UNAVAILABLE");
    }

    (await cookies()).set(INVITE_COOKIE, token, INVITE_COOKIE_OPTIONS);

    const callback = new URL("/auth/callback", publicEnv().NEXT_PUBLIC_SITE_URL);
    callback.searchParams.set("next", "/invite/complete");
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: callback.toString() },
    });
    if (otpError) {
      if (otpError.status === 429) throw new AppError("RATE_LIMITED");
      logger.error("invitation.otp_failed", { correlation_id: correlationId, status: otpError.status });
      throw new AppError("PROVIDER_UNAVAILABLE");
    }

    const [local, domain] = email.split("@");
    return { sentTo: `${local[0]}${"•".repeat(Math.max(local.length - 1, 1))}@${domain}` };
  });
  if (redirectTo) redirect(redirectTo);
  return result;
}

const helpSchema = z.object({
  token: z.string(),
  kind: z.enum(["new_link", "question", "changes", "call"]),
  message: z.string().trim().max(2000).optional(),
});

/** Questions, change requests and new-link requests become a follow-up for the owner. */
export async function requestInvitationHelp(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("invitation.request_help", async (correlationId) => {
    const parsed = helpSchema.safeParse(formObject(formData, ["token", "kind", "message"]));
    if (!parsed.success) throw fromZodError(parsed.error);
    await assertRateLimit(RATE_RULES.publicForm);
    // Unknown or malformed tokens get the same success response.
    if (!isPlausibleInvitationToken(parsed.data.token)) return null;

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("request_invitation_help", {
      p_token_hash: hashInvitationToken(parsed.data.token),
      p_kind: parsed.data.kind,
      p_message: parsed.data.message,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    return null;
  });
}
