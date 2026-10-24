import { createServerClient } from "@supabase/ssr";
import type { BrowserContext } from "@playwright/test";

const FIXTURE_PASSWORD = process.env.TEST_USER_PASSWORD ?? "clientos-rls-fixture-Pa55!";

export const hasAuthEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SECRET_KEY,
);

/**
 * Sign a fixture user in with a password (dev project only) and copy the
 * exact session cookies @supabase/ssr would set into the browser context.
 * Fixture users are created by the security suite (tests/security).
 */
export async function signInContext(context: BrowserContext, email: string, baseURL: string) {
  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => cookies.forEach(({ name, value }) => jar.set(name, value)),
      },
    },
  );
  const { error } = await supabase.auth.signInWithPassword({ email, password: FIXTURE_PASSWORD });
  if (error) throw new Error(`fixture sign-in failed for ${email}: ${error.message}`);
  const url = new URL(baseURL);
  await context.addCookies(
    [...jar].map(([name, value]) => ({
      name,
      value,
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
  );
}
