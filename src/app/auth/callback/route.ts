import { NextResponse, type NextRequest } from "next/server";

import { safeRedirectPath } from "@/lib/safe-redirect";
import { logger } from "@/server/logger";
import { createSupabaseServerClient } from "@/server/supabase/server";

/** PKCE magic-link callback: exchange the one-time code for a session cookie. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    logger.warn("auth.callback_failed", { status: error.status, code: error.code });
  }

  return NextResponse.redirect(new URL("/login?error=link_invalid", origin));
}
