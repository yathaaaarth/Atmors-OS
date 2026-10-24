/**
 * Bootstrap an organization and grant a team member access. Idempotent.
 * Uses the secret (service role) key, so run it only from a trusted machine.
 *
 *   npm run bootstrap -- --email someone@atmors.com --name "Full Name" --role cto_coo
 *   npm run bootstrap -- --email someone@atmors.com --role delivery --org-slug atmors --org-name "Atmors"
 *
 * The user signs in afterwards with a magic link from /login. No password is set.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { createClient } from "@supabase/supabase-js";

const ROLES = ["ceo", "cto_coo", "sales", "delivery"] as const;
type Role = (typeof ROLES)[number];

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string", default: "" },
    role: { type: "string" },
    "org-slug": { type: "string", default: "atmors" },
    "org-name": { type: "string", default: "Atmors" },
  },
});

function fail(message: string): never {
  console.error(`bootstrap: ${message}`);
  process.exit(1);
}

const email = values.email?.trim().toLowerCase();
const role = values.role as Role | undefined;
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("--email is required");
if (!role || !ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(", ")}`);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!url || !secretKey) fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local");

const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const correlationId = `bootstrap-${randomUUID()}`;

async function findUserId(target: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .upsert({ slug: values["org-slug"], name: values["org-name"] }, { onConflict: "slug" })
    .select("id, name")
    .single();
  if (orgError) throw orgError;

  let userId = await findUserId(email!);
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: email!,
      email_confirm: true,
      user_metadata: { display_name: values.name },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`created user ${email}`);
  }
  if (values.name) {
    const { error } = await admin.from("profiles").update({ display_name: values.name }).eq("id", userId);
    if (error) throw error;
  }

  const { data: existing, error: existingError } = await admin
    .from("organization_memberships")
    .select("id, role, status")
    .eq("organization_id", org.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throw existingError;

  const { data: membership, error: membershipError } = await admin
    .from("organization_memberships")
    .upsert(
      { organization_id: org.id, user_id: userId, role, status: "active" },
      { onConflict: "organization_id,user_id" },
    )
    .select("id, role, status")
    .single();
  if (membershipError) throw membershipError;

  const { error: auditError } = await admin.from("audit_logs").insert({
    organization_id: org.id,
    actor_type: "system",
    action: existing ? "membership.updated" : "membership.created",
    entity_type: "organization_membership",
    entity_id: membership.id,
    before_summary: existing ? { role: existing.role, status: existing.status } : null,
    after_summary: { role: membership.role, status: membership.status },
    reason: "bootstrap script",
    correlation_id: correlationId,
  });
  if (auditError) throw auditError;

  console.log(`${email} is ${membership.role} (${membership.status}) in ${org.name}. ref ${correlationId}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : JSON.stringify(error));
});
