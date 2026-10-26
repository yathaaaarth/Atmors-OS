import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

/**
 * In-process Postgres with minimal stand-ins for Supabase's auth schema and
 * roles, running every migration in order. Exercises SQL business rules
 * (RPCs, triggers, constraints) without a hosted project. RLS and grants are
 * covered by tests/security against real Supabase.
 */
export async function migratedDatabase() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create schema extensions;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  `);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }

  async function run<T>(userId: string | null, sql: string, params: unknown[]) {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ""]);
    return (await db.query<T>(sql, params)).rows;
  }

  /** Run a query as the given user (null = no session). Failures include the RPC's internal detail. */
  async function as<T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []) {
    try {
      return await run<T>(userId, sql, params);
    } catch (error) {
      const detail = (error as { detail?: string }).detail;
      if (detail && error instanceof Error) error.message = `${error.message} (${detail})`;
      throw error;
    }
  }

  /** Resolve to the raised error message (the stable code), or null on success. */
  async function errorOf(userId: string | null, sql: string, params: unknown[] = []) {
    try {
      await run(userId, sql, params);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  return { db, as, errorOf };
}
