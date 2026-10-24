# Decision log

These are the technical decisions made during implementation. Product decisions are locked in the PRD's decision baseline. Open provider choices are tracked in [provider-register.md](provider-register.md).

## D-001: Hosted Supabase project for development

- **Date:** 2026-10-24 · **Status:** accepted
- **Context:** There is no Docker on the development machine, so the local Supabase stack isn't available.
- **Decision:** Use a dedicated hosted Supabase *dev* project. Apply migrations with `npm run db:push` (Supabase CLI, linked). Production and staging get separate projects with separate keys (PRD §16).
- **Consequences:** The RLS tests create persistent fixture organizations and users (`rls-fixture*`, `*+clientos@example.com`) in the dev project, so they must never run against staging or production. Local resets are not possible; every schema change goes through a new migration.

## D-002: Single Next.js app at the repo root

- **Date:** 2026-10-24 · **Status:** accepted
- **Context:** The PRD's suggested layout includes `apps/web`. There is only one deployable app.
- **Decision:** Put the app at the repo root and keep the PRD's module boundaries inside `src/` (`src/modules/*`, `src/server/*`). Move to a workspace layout only when a second deployable appears.

## D-003: Transactional writes go through Postgres RPCs

- **Date:** 2026-10-24 · **Status:** accepted
- **Context:** The PRD requires state change, audit entry and workflow event to be atomic (§8). supabase-js has no multi-statement transactions.
- **Decision:** Privileged or multi-record writes are `SECURITY DEFINER` RPCs that re-check permissions and call `private.write_audit` and `private.write_workflow_event`. Application services validate inputs (Zod) and pre-check permissions, so callers get clear errors. RPCs raise stable error codes as their message, and `fromPostgrestError` maps them.
- **Consequences:** Some business rules live in SQL, and every one is covered by `tests/security`.

## D-004: Cache Components disabled for now

- **Date:** 2026-10-24 · **Status:** accepted
- **Context:** Next.js 16 scaffolds with `cacheComponents: true`, which requires every session read to sit behind Suspense and adds caching rules on top. Every screen in ClientOS is per-user and auth-gated.
- **Decision:** Set `cacheComponents: false`. Revisit if static marketing pages or heavy shared data appear.

## D-005: Magic-link sign-in, invite-only accounts

- **Date:** 2026-10-24 · **Status:** accepted
- **Decision:** Public signup is disabled. Internal users are provisioned with `npm run bootstrap` and sign in with an emailed single-use link (PKCE through `/auth/callback`, or token hash through `/auth/confirm`). MFA (TOTP) for internal users is required before the live pilot.
