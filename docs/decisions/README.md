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

## D-006: `sales` role for commercial staff without approval authority

- **Date:** 2026-10-25 · **Status:** accepted
- **Context:** AT-008 requires a user who can build proposals but can't send discounted ones without approval. The PRD's four named people don't include such a role, and without one AT-008 can't actually occur.
- **Decision:** Add `sales` with `_own` permissions (own prospects and proposals only) and no approval authority. No one holds it by default. CEO approval (`proposals.approve`) is required for discounts, non-standard terms and margin exceptions.

## D-007: One `proof_assets` table for testimonials and case studies

- **Date:** 2026-10-25 · **Status:** accepted
- **Context:** The PRD lists `testimonials` and `case_studies` separately, but both have the same permission, publication, withdrawal and visibility rules.
- **Decision:** Use a single table with `kind`, plus kind-specific check constraints. This keeps AT-009 visibility logic (`private.proof_is_visible`) in one place.

## D-008: The secret key is used at runtime, for invitation sign-in only

- **Date:** 2026-10-25 · **Status:** accepted
- **Context:** Public signup is off, so an invited client has no account until one is provisioned. Looking up the email an invitation is bound to must not be possible from client sessions.
- **Decision:** `src/server/supabase/admin.ts` (server-only) is used in exactly one server action, `beginInvitationSignIn`. It calls the service-role-only RPC `invitation_contact` and `auth.admin.createUser` for that email. `SUPABASE_SECRET_KEY` must therefore be set in the server environment (never `NEXT_PUBLIC_`).

## D-009: Rate limiting at the hosting edge

- **Date:** 2026-10-25 · **Status:** accepted, action before the pilot
- **Context:** The PRD requires rate limits on public endpoints. In-memory limits don't work across serverless instances, and the token-holder RPCs are callable through Supabase's API as well as through the app.
- **Decision:** Rely on token entropy and input caps now. Configure per-IP limits for `/i/*`, `/login` and `/api/*` in the hosting platform's firewall once hosting is chosen (provider register), and treat it as a pilot release gate. Supabase Auth already rate-limits magic-link emails.

## D-010: Transactional email goes through Supabase Auth for now

- **Date:** 2026-10-25 · **Status:** temporary
- **Context:** Email delivery isn't approved yet (Resend is proposed). Supabase's built-in email sender is heavily rate-limited and only delivers to the project's team members.
- **Decision:** Invitation links are copied by staff and sent manually ("Mark as sent" records the outreach). Magic links use Supabase Auth email. **Before real clients use it, configure custom SMTP (for example Resend) in Supabase Auth.** Otherwise clients won't receive sign-in links.

## D-011: SQL rules are tested on in-process Postgres (PGlite)

- **Date:** 2026-10-25 · **Status:** accepted
- **Context:** The hosted project can't be reset, some cases (such as expiry) can't be arranged there, and CI has no Supabase credentials.
- **Decision:** `tests/db` applies every migration to PGlite with stand-ins for Supabase `auth` and roles, and tests RPCs, triggers and constraints. RLS and grants are still verified against real Supabase in `tests/security`.
