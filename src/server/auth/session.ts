import "server-only";

import { cache } from "react";

import { AppError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

export type SessionUser = {
  id: string;
  email: string | null;
};

/**
 * The verified user for this request (JWT validated by getClaims), or null.
 * Memoized per request.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return {
    id: data.claims.sub,
    email: typeof data.claims.email === "string" ? data.claims.email : null,
  };
});

export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AppError("UNAUTHENTICATED");
  return user;
}
