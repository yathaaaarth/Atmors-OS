import { NextResponse, type NextRequest } from "next/server";

import { hashInvitationToken, isPlausibleInvitationToken } from "@/modules/crm/invitation-token";
import { CORRELATION_HEADER, resolveCorrelationId } from "@/server/correlation";
import { fromPostgrestError } from "@/server/errors";
import { INVITE_COOKIE } from "@/server/invitations";
import { logger } from "@/server/logger";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Landing point after the invited contact clicks their magic link: binds the
 * invitation (held in an httpOnly cookie) to the now-verified account.
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_HEADER));
  const token = request.cookies.get(INVITE_COOKIE)?.value;

  const finish = (path: string) => {
    const response = NextResponse.redirect(new URL(path, origin));
    response.cookies.delete(INVITE_COOKIE);
    return response;
  };

  if (!token || !isPlausibleInvitationToken(token)) return finish("/portal");

  const supabase = await createSupabaseServerClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return NextResponse.redirect(new URL("/login?next=/invite/complete", origin));

  const { data, error } = await supabase.rpc("redeem_invitation", {
    p_token_hash: hashInvitationToken(token),
    p_correlation_id: correlationId,
  });
  if (error) {
    const appError = fromPostgrestError(error);
    logger.warn("invitation.redeem_failed", { correlation_id: correlationId, code: appError.code });
    return finish(`/portal?invite_error=${appError.code}`);
  }
  return finish(data ? `/portal/proposals/${data}` : "/portal");
}
