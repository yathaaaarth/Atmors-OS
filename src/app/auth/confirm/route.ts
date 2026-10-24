import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { safeRedirectPath } from "@/lib/safe-redirect";
import { logger } from "@/server/logger";
import { createSupabaseServerClient } from "@/server/supabase/server";

const ALLOWED_TYPES: EmailOtpType[] = ["email", "magiclink", "invite", "recovery", "email_change"];

/**
 * Token-hash verification for email templates that link to
 * /auth/confirm?token_hash={{ .TokenHash }}&type=email. Works across devices,
 * unlike the PKCE callback.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeRedirectPath(searchParams.get("next"));

  if (tokenHash && type && ALLOWED_TYPES.includes(type)) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(new URL(next, origin));
    logger.warn("auth.confirm_failed", { status: error.status, code: error.code });
  }

  return NextResponse.redirect(new URL("/login?error=link_invalid", origin));
}
