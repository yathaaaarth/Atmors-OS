import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/server/supabase/database.types";

export type TypedClient = SupabaseClient<Database>;
type Role = Database["public"]["Enums"]["member_role"];

export const supabaseTestEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  secretKey: process.env.SUPABASE_SECRET_KEY ?? "",
};

export const hasSupabaseTestEnv = Boolean(
  supabaseTestEnv.url && supabaseTestEnv.publishableKey && supabaseTestEnv.secretKey,
);

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } } as const;

// Fixed fixture password for throwaway test accounts in the dev project only.
const FIXTURE_PASSWORD = process.env.TEST_USER_PASSWORD ?? "clientos-rls-fixture-Pa55!";

export function adminClient(): TypedClient {
  return createClient<Database>(supabaseTestEnv.url, supabaseTestEnv.secretKey, clientOptions);
}

export function anonClient(): TypedClient {
  return createClient<Database>(supabaseTestEnv.url, supabaseTestEnv.publishableKey, clientOptions);
}

async function findUserIdByEmail(admin: TypedClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Find-or-create a confirmed test user and reset its password so sign-in is deterministic. */
export async function ensureUser(admin: TypedClient, email: string, displayName: string): Promise<string> {
  const existing = await findUserIdByEmail(admin, email);
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing, { password: FIXTURE_PASSWORD });
    if (error) throw error;
    return existing;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: FIXTURE_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (error) throw error;
  return data.user.id;
}

export async function signedInClient(email: string): Promise<TypedClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: FIXTURE_PASSWORD });
  if (error) throw error;
  return client;
}

export async function ensureOrganization(admin: TypedClient, slug: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from("organizations")
    .upsert({ slug, name }, { onConflict: "slug" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function ensureMembership(
  admin: TypedClient,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<string> {
  const { data, error } = await admin
    .from("organization_memberships")
    .upsert(
      { organization_id: organizationId, user_id: userId, role, status: "active" },
      { onConflict: "organization_id,user_id" },
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function ensureProspect(
  admin: TypedClient,
  organizationId: string,
  ownerUserId: string,
  email: string,
  name = "Fixture Prospect",
): Promise<string> {
  const { data: existing, error: findError } = await admin
    .from("prospects")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("normalized_email", email.toLowerCase())
    .maybeSingle();
  if (findError) throw findError;
  if (existing) {
    const { error } = await admin.from("prospects").update({ owner_user_id: ownerUserId, name }).eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }
  const { data, error } = await admin
    .from("prospects")
    .insert({ organization_id: organizationId, owner_user_id: ownerUserId, name, email })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}
