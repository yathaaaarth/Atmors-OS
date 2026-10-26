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

## D-012: Provider webhooks are verified in the app and applied in the database

- **Date:** 2026-10-26 · **Status:** accepted
- **Context:** PRD §9 asks webhook handlers to verify, persist idempotently and respond promptly. Signature secrets must stay server-side, and the business effects (allocation, activation) must be one transaction.
- **Decision:** `/api/webhooks/{payments|esign}/[provider]` verifies the HMAC of the raw body with the adapter, normalizes the event and calls a service-role-only ingest RPC. The RPC deduplicates on the provider event ID (verified events only), matches order, amount, currency and merchant account, and applies effects in the same transaction. Processing is synchronous for now; the event row records the outcome so a background worker can take over later without changing the contract. Quarantined, verified events can be replayed by `billing.manage` after the cause is fixed.
- **Consequences:** The secret key is now also used by the webhook routes and to attach provider orders (`src/server/supabase/admin.ts`).

## D-013: Sandbox providers for development, guarded twice

- **Date:** 2026-10-26 · **Status:** accepted
- **Context:** The e-signature vendor is undecided and Razorpay merchant keys don't exist yet, but the flows and AT-012 to AT-020 must be exercised end to end.
- **Decision:** Sandbox payment and e-signature adapters sign their events with `SANDBOX_WEBHOOK_SECRET` and send them through the real ingest path. They work only when `ENABLE_SANDBOX_PROVIDERS=true` (forced off when `VERCEL_ENV=production`) **and** the organization has an active `sandbox` integration account.
- **Consequences:** Never set either in production. The sandbox signing step is an authenticated portal action; a real vendor will instead return its own signing URL from the adapter.

## D-014: Internal shared booking layer with database conflict prevention

- **Date:** 2026-10-26 · **Status:** accepted
- **Context:** PRD §5.4 fixes one shared booking system with centralized conflict prevention; the scheduling provider is open.
- **Decision:** Canonical `meetings` table with a Postgres exclusion constraint (`btree_gist`) so one host can never hold overlapping active bookings, even under concurrent requests. Availability is weekly hours per host in the host's timezone. Commercial calls route to the prospect owner if they take commercial calls, otherwise to the pool; the least-loaded free host is chosen at booking time. A losing request gets alternative slots. Callback requests are written straight to the database as tasks, so they work when booking does not (`SCHEDULING_PROVIDER=disabled` simulates an outage).
- **Consequences:** No calendar sync yet: hosts' external calendars are not consulted. Reminder emails wait for the email provider (D-010).

## D-015: Activation is evaluated per agreement until workspaces exist

- **Date:** 2026-10-26 · **Status:** accepted
- **Context:** Phase 3 needs the activation evaluator; workspaces arrive in Phase 4.
- **Decision:** Each agreement stores its own activation policy (PRD §8 shape), chosen when it is generated. `private.evaluate_activation` reads authoritative records and appends an evaluation (eligible, blocking reasons, policy version). It runs after signature and payment events and on demand. Requiring onboarding approval always blocks until Phase 4 supplies it. Becoming eligible creates a kickoff task; losing eligibility (for example after a refund) creates a review task.
- **Consequences:** Phase 4 attaches workspaces to this evaluator instead of re-deriving eligibility.

## D-016: Invoice numbering and tax figures are placeholders pending accountant review

- **Date:** 2026-10-26 · **Status:** temporary
- **Decision:** Invoices are numbered `INV-<FY>-<seq>` per Indian financial year. The tax on each instalment is a proportional estimate of the accepted version's tax, stored in `tax_snapshot` with `review_required`. No credit notes yet: refunds and disputes are recorded as payment adjustments.
- **Consequences:** A qualified accountant must approve numbering, GST treatment and credit-note handling before production (PRD §5.6).

## D-017: One onboarding per client with immutable submission revisions

- **Date:** 2026-10-27 · **Status:** accepted
- **Decision:** Each client has one `onboardings` row (the state machine) with a mutable draft. Every submission creates an immutable `onboarding_submissions` revision with its own `onboarding_answers` (source `client`) and an answers hash; reviews are append-only and always target the latest revision (an older one is `VERSION_STALE`). Answers are cleaned in SQL against the versioned questionnaire: unknown keys and hidden follow-ups are dropped, types and options are checked. AI interpretations (Phase 5) live in a separate table and can never write answers (AT-021).
- **Consequences:** Onboarding starts automatically when the agreement is executed, or earlier through `start_onboarding` when policy allows.

## D-018: Uploads go through the app; the bucket is private

- **Date:** 2026-10-27 · **Status:** accepted
- **Context:** PRD §5.7 asks for type/size limits, content validation where feasible and short-lived signed URLs.
- **Decision:** `POST /api/assets` (same-origin, signed-in) checks size, type, extension and content signature, registers the asset as the client (the database checks access and quota) and stores it in the private `client-assets` bucket with the system identity. Downloads go through `/api/assets/[id]`, which authorizes and audits, then redirects to a 60-second signed URL.
- **Consequences:** Files pass through the app server (10 MB cap). No malware scanning yet (`scan_status = not_scanned`).

## D-019: Workspaces activate automatically when eligible and never deactivate automatically

- **Date:** 2026-10-27 · **Status:** accepted
- **Decision:** The workspace is created (blocked) when the agreement is executed and follows the agreement's activation evaluation: it becomes active as soon as the configured conditions are met (AT-025). If conditions later fail (for example a refund), it stays active and a review task is raised; suspending is a human decision. Manual override needs `workspaces.override` and a reason, is audited and stays visibly marked, and never creates payment or signature records (AT-026). Kickoff readiness additionally needs approved onboarding and a delivery lead.

## D-020: Per-host advisory lock for bookings

- **Date:** 2026-10-27 · **Status:** accepted
- **Context:** The hosted concurrency test showed that simultaneous inserts against the exclusion constraint can deadlock (40P01) instead of failing cleanly.
- **Decision:** Booking and rescheduling take `pg_advisory_xact_lock` per host before writing, so concurrent requests queue; a deadlock, if one still occurs, is treated as "slot taken". The exclusion constraint remains the guarantee.

## D-021: AI behind a provider interface; offline provider by default

- **Date:** 2026-10-28 · **Status:** accepted (vendor still open in the provider register)
- **Decision:** `src/server/ai` defines `generate(request) -> response` with normalized error categories. Adapters: `anthropic` (Claude via the official SDK: `claude-opus-5-5`, effort `low` by default for chat, structured output through `output_config.format`, refusal handling, and server-side `fallbacks: "default"` under beta `server-side-fallback-2026-07-01`, switchable off with `AI_FALLBACKS=off`), `local` (offline extractive answers from approved context only) and `disabled`. `AI_PROVIDER` selects one; the default is `local`, so no prompts leave the system until a vendor is approved.
- **Consequences:** The policy layer (`policy.ts`) applies to every provider and is tested with deliberately bad outputs. Changing vendors means adding an adapter and re-running `npm run ai:eval`.

## D-022: The model gets no tools; it proposes and people confirm

- **Date:** 2026-10-28 · **Status:** accepted
- **Decision:** Responses are a fixed structured shape (answer, grounded, citations, needs_human, optional task suggestion and follow-up draft). The application turns those into `ai_tool_events` (`request_human_help`, `propose_task`, `draft_follow_up`) that run only when the right person clicks to confirm, through the normal RPCs that re-check permission. Drafts are never sent by the system. Each question is answered on its own (no replayed history), which limits prompt-injection carry-over.

## D-023: Strategist output is a separate draft note

- **Date:** 2026-10-28 · **Status:** accepted
- **Decision:** The onboarding strategist writes `onboarding_ai_notes` (flags, draft questions, a brief labelled as interpretation, missing assets) for the reviewer. The reviewer can copy the questions into the review form and edit them before sending. No code path writes `onboarding_answers` other than a client submission (AT-021).

## D-024: Notifications are an outbox filled by database triggers

- **Date:** 2026-10-29 · **Status:** accepted
- **Decision:** Business state changes enqueue a row in `notifications` with a unique idempotency key from database triggers. Triggers are on agreements, invoices, meetings, onboarding, workspaces and proposals. Enqueueing happens in the same transaction as the change, so a rolled-back change sends nothing and a replayed one adds nothing. `/api/cron/dispatch` claims due rows with `FOR UPDATE SKIP LOCKED`, sends through the email adapter (Resend, or a log provider without keys) with the same key as the provider's idempotency key, and retries with backoff up to five attempts before raising an Operations task (AT-031). Emails carry portal links, not terms or amounts.

## D-025: Scheduled jobs through authenticated cron routes

- **Date:** 2026-10-29 · **Status:** accepted
- **Decision:** `/api/cron/dispatch` (every 5 minutes) and `/api/cron/daily` (billing checks, meeting reminders, stale-payment tasks) run on Vercel Cron with `Authorization: Bearer $CRON_SECRET`. They fail closed without the secret and record each run in `job_runs`, shown on Operations. Every job is idempotent. A managed job service (Trigger.dev, provider register) can replace the scheduler without changing the jobs. *Scheduler superseded by D-028 for the free tier: GitHub Actions calls the same routes.*

## D-026: Application-level rate limits in Postgres

- **Date:** 2026-10-29 · **Status:** accepted
- **Decision:** In addition to edge limits (D-009), the app counts requests per hashed IP (or user) in fixed windows in `rate_limits`, so limits hold across serverless instances. It fails open, with a log entry, if the limiter itself is unavailable. Raw IP addresses are never stored.

## D-027: Nonce-based CSP and staff MFA

- **Date:** 2026-10-29 · **Status:** accepted
- **Decision:** `src/proxy.ts` issues a per-request nonce CSP: scripts need the nonce, with `strict-dynamic` for the Razorpay checkout; no plugins; no framing. Inline style attributes are allowed because UI libraries use them. Staff who have enrolled TOTP must reach AAL2 each session before dashboard pages or staff actions run; `REQUIRE_STAFF_MFA=true` makes enrollment mandatory and is required in staging and production.

## D-028: Free-tier hosting for the pilot

- **Date:** 2026-10-29 · **Status:** accepted
- **Decision:** Vercel Hobby (region `bom1`, next to Supabase `ap-south-1`), Supabase Free (the existing project for development and tests, a second one for production), Resend Free, and GitHub Actions for the scheduler (`scheduled-jobs.yml`, every 5 minutes plus daily) and for nightly backups (`backup.yml`: `pg_dump`, encrypted with AES-256 before upload because the repository is public, kept 30 days). Vercel Cron is not used because Hobby only allows daily jobs.
- **Consequences:** No separate staging project (two free projects only); releases are rehearsed on Vercel preview deployments against the dev project. RPO is 24 hours. Vercel's Hobby terms are for non-commercial use, so move to Pro when usage becomes commercial. The upgrade path changes configuration, not code (docs/deployment.md).

