# Release readiness

Status of every acceptance test (PRD §14) and release gate (PRD §15, §17, §19). "Automated" means a test in this repository fails if the behaviour breaks.

Test suites: `npm test` (unit and database rules on PGlite), `npm run test:security` (RLS and grants on the hosted dev project), `npm run test:e2e` (browser), `npm run ai:eval` (AI evaluation).

## Acceptance tests

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| AT-001 | Invitation scope | Automated | `security/phase2.test.ts` |
| AT-002 | Expired invitation | Automated | `security/phase2.test.ts`, `db/phase2-rules.test.ts` |
| AT-003 | Revocation | Automated | `security/phase2.test.ts` |
| AT-004 | Sensitive action authentication | Automated | `security/phase2.test.ts`, `security/phase3.test.ts` (signing, paying) |
| AT-005 | Custom proposal | Automated | `security/phase2.test.ts`, `unit/money.test.ts` |
| AT-006 | Proposal versioning | Automated | `security/phase2.test.ts`, `db/phase2-rules.test.ts` |
| AT-007 | Exact-version acceptance | Automated | `security/phase2.test.ts`, `db/phase2-rules.test.ts` |
| AT-008 | Discount approval | Automated | `security/phase2.test.ts` |
| AT-009 | Proof permission | Automated | `security/phase2.test.ts` |
| AT-010 | Booking conflict | Automated | `db/phase3-rules.test.ts`; five-way concurrent race on hosted Postgres in `security/phase3.test.ts` |
| AT-011 | Booking failure | Automated | `db/phase3-rules.test.ts`, `security/phase3.test.ts`; `SCHEDULING_PROVIDER=disabled` for manual drills |
| AT-012 | Contract snapshot | Automated | `db/phase3-rules.test.ts`, `e2e/agreement-journey.spec.ts` |
| AT-013 | Executed contract immutability | Automated | `db/phase3-rules.test.ts` |
| AT-014 | Webhook signature | Automated | `unit/integrations.test.ts`, `db/phase3-rules.test.ts`, `security/phase3.test.ts` |
| AT-015 | Duplicate payment event | Automated | `db/phase3-rules.test.ts`, `security/phase3.test.ts` |
| AT-016 | Payment amount mismatch | Automated | `db/phase3-rules.test.ts`, `security/phase3.test.ts` |
| AT-017 | Delayed payment event | Automated | `db/phase3-rules.test.ts`, `e2e/agreement-journey.spec.ts` |
| AT-018 | Package-specific schedule | Automated | `db/phase3-rules.test.ts` |
| AT-019 | Failed or partial payment | Automated | `db/phase3-rules.test.ts` |
| AT-020 | Refund or dispute | Automated | `db/phase3-rules.test.ts` |
| AT-021 | Onboarding revisions | Automated | `db/phase4-rules.test.ts`, `unit/ai.test.ts` |
| AT-022 | Unsafe file | Automated | `unit/onboarding.test.ts`, `db/phase4-rules.test.ts`, `security/phase4.test.ts`, `e2e/agreement-journey.spec.ts` |
| AT-023 | Least privilege | Automated | `db/phase4-rules.test.ts`, `security/phase4.test.ts` |
| AT-024 | RLS bypass attempt | Automated | `security/*.test.ts`, `db/hardening.test.ts` (catalog-wide) |
| AT-025 | Activation policy | Automated | `db/phase4-rules.test.ts` |
| AT-026 | Manual override | Automated | `db/phase4-rules.test.ts`, `security/phase4.test.ts` |
| AT-027 | AI groundedness | Automated | `unit/ai.test.ts`, `npm run ai:eval` |
| AT-028 | AI cross-client isolation | Automated | `unit/ai.test.ts`, `db/phase5-rules.test.ts`, `security/phase5.test.ts` |
| AT-029 | AI action boundary | Automated | `unit/ai.test.ts`, `db/phase5-rules.test.ts` |
| AT-030 | Provider failure | Automated | `unit/ai.test.ts` (normalized errors, fallback, budgets) |
| AT-031 | Notification idempotency | Automated | `db/hardening.test.ts`, `unit/hardening.test.ts` |
| AT-032 | Audit completeness | Automated | `db/hardening.test.ts` |
| AT-033 | Mobile and accessibility | Automated | `e2e/accessibility.spec.ts` (axe, desktop and mobile), `e2e/smoke.spec.ts` (keyboard) |
| AT-034 | Backup and recovery | **Open** | Encrypted database and file backups every 6 hours (`.github/workflows/backup.yml`) and the restore procedure in `runbooks/backup-restore.md`; the restore exercise runs once the first backup exists |
| AT-035 | Deployment rollback | Documented | `runbooks/deployment-rollback.md`; additive migrations and idempotent jobs. Do one rollback drill (Vercel Instant Rollback) after the first production deploy |

## Release gates still open

These need decisions, accounts or professional review outside the code. None of them is a missing feature.

1. **Hosting (free tier, D-028):** production Supabase project, Vercel Hobby deployment, GitHub Actions secrets for the scheduler and backups; see `docs/deployment.md`.
2. **Email:** custom SMTP for Supabase Auth sign-in links, plus `RESEND_API_KEY`/`EMAIL_FROM` and a verified sending domain for notifications (D-010).
3. **Payments:** Razorpay merchant approval (with international cards) and a PayPal Business account (D-030). Then run the PRD §10 provider tests in Razorpay test mode and the PayPal sandbox: wrong amount, wrong currency, duplicate, delayed, failed, refund and outage. The sandbox already covers the same paths.
4. **E-signature:** the built-in signer is ready (D-029); a lawyer should confirm it suits your agreements and client countries.
5. **AI vendor:** run `npm run ai:eval` with each candidate, approve one, then set `AI_PROVIDER`.
6. **Legal and accounting:** approve the agreement template, privacy notice, consent wording, GST, LUT and export-invoice wording and invoice numbering (D-016, D-030), and retention.
7. **Security settings in production:**
   - `REQUIRE_STAFF_MFA=true`;
   - edge rate limits in front of `/i/*`, `/login` and `/api/*` (D-009; the app also enforces its own limits);
   - no sandbox providers;
   - a `CRON_SECRET` of at least 32 characters.
8. **AT-034 restore exercise** and one rollback drill on staging.
9. **Pilot:** a small number of real clients, with daily review of Operations, AI usage and the audit log for the first two weeks.

## International payments and built-in signing (D-029, D-030)

| Check | Status | Evidence |
|---|---|---|
| Built-in signer: only the named signer, emailed code, 5 attempts, checksum-bound, evidence recorded | Pass | `tests/db/international-signing.test.ts`, `tests/security/international.test.ts` |
| PayPal: order for the exact amount, idempotent create and capture, verified webhooks, refunds and disputes | Pass (unit) | `tests/unit/international.test.ts`; live sandbox run pending PayPal credentials |
| Bank transfer: instructions on unpaid invoices only; a report creates one finance task, never a payment | Pass | `tests/db/international-signing.test.ts` |
| Export invoices: country on the agreement, LUT note, seller and buyer details, printable | Pass | DB tests; printable pages under `/portal/invoices/[id]/print` and `/dashboard/billing/invoices/[id]/print` |
| Legal review of the signing process and template | **Open** | Lawyer |
| Accountant review of invoice numbering, GST and LUT wording | **Open** | Accountant |
