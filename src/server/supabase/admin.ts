import "server-only";

import { createClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env";

import type { Database } from "./database.types";

/**
 * Service-role client. It bypasses RLS, so it is used ONLY for the narrow
 * system steps that cannot run as the caller (resolving the email an
 * invitation is bound to and provisioning that client's auth account).
 * Never pass user-controlled filters to it without validating them first.
 */
export function createSupabaseAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is required for invitation sign-in. See .env.example.");
  }
  return createClient<Database>(publicEnv().NEXT_PUBLIC_SUPABASE_URL, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
