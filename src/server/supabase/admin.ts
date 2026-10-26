import "server-only";

import { createClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env";

import type { Database } from "./database.types";

/**
 * Service-role client: the system worker identity (PRD §2). It bypasses RLS,
 * so it is used ONLY for steps that cannot run as the caller (D-008, D-012):
 * invitation sign-in, recording verified provider events, and attaching a
 * provider order to a payment the client already created. Never pass
 * user-controlled filters to it without validating them first.
 */
export function createSupabaseAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is required for system steps (invitations, webhooks). See .env.example.");
  }
  return createClient<Database>(publicEnv().NEXT_PUBLIC_SUPABASE_URL, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
