import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/server/supabase/server";

export type MfaRequirement = "ok" | "challenge" | "enroll";

/**
 * Staff session assurance (PRD §2, D-005). A member with an authenticator
 * must verify it each session (AAL2) before using the dashboard; with
 * REQUIRE_STAFF_MFA=true, members without one must enroll first.
 */
export const staffMfaRequirement = cache(async (): Promise<MfaRequirement> => {
  const { data, error } = await verifiedAssuranceLevel();
  if (error || !data) return process.env.REQUIRE_STAFF_MFA === "true" ? "enroll" : "ok";
  return decideMfa(data.currentLevel, data.nextLevel, process.env.REQUIRE_STAFF_MFA === "true");
});

/**
 * Assurance level from the Auth server, not the cookie. Without a JWT,
 * getAuthenticatorAssuranceLevel() reads the user's factors from the session
 * cookie, which the browser controls: deleting them would skip the challenge.
 * Passing the access token makes it load the factors with getUser(jwt).
 */
export const verifiedAssuranceLevel = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session) return { data: null, error: null };
  return supabase.auth.mfa.getAuthenticatorAssuranceLevel(data.session.access_token);
});

/** Pure decision, for tests. */
export function decideMfa(current: string | null, next: string | null, required: boolean): MfaRequirement {
  if (current === "aal2") return "ok";
  if (next === "aal2") return "challenge";
  return required ? "enroll" : "ok";
}
