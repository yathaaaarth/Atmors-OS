# Deployment guide

This is the target setup for staging and production. Deployment itself is still to be agreed; this file lists what each environment needs.

## Environments

Use separate Supabase projects, keys and provider accounts for **development** (the current hosted dev project), **staging** and **production** (PRD §16). Never use production secrets locally.

## Supabase (per environment)

1. Create the project (region `ap-south-1`).
2. Apply migrations: `npm run db:link -- --project-ref <ref>` then `npm run db:push`.
3. Authentication:
   - turn signups off;
   - set the Site URL and Redirect URLs to `https://<domain>/**`;
   - configure custom SMTP;
   - make sure TOTP MFA is enabled.
4. Storage: the `client-assets` bucket is created by the migration (private). Confirm it shows as private.
5. Backups: enable Point-in-Time Recovery for production (see `runbooks/backup-restore.md`).
6. Create the organization and staff: `npm run bootstrap -- --email … --name … --role …`.

## Hosting (Vercel proposed)

1. Import the repository; framework Next.js; Node 24.
2. Environment variables (Production and Preview separately):

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from the environment's Supabase project |
| `NEXT_PUBLIC_SITE_URL` | `https://<domain>` |
| `SUPABASE_SECRET_KEY` | server only |
| `CRON_SECRET` | 32+ random characters; Vercel Cron sends it automatically |
| `RESEND_API_KEY`, `EMAIL_FROM` | notifications; without them emails are only logged |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | after merchant approval; then enable the account under Billing → Providers |
| `REQUIRE_STAFF_MFA=true` | production and staging |
| `AI_PROVIDER` (+ `ANTHROPIC_API_KEY`, …) | optional; default `local` |
| `ENABLE_SANDBOX_PROVIDERS`, `SANDBOX_WEBHOOK_SECRET` | **never in production**; staging only if you want test payments |

3. Cron (`vercel.json`): the dispatcher every 5 minutes and the daily checks at 08:00 IST. Vercel's Hobby plan only allows daily crons; on Hobby, use an external scheduler that calls `/api/cron/dispatch` with `Authorization: Bearer $CRON_SECRET`, or upgrade.
4. Webhooks:
   - Razorpay: `https://<domain>/api/webhooks/payments/razorpay` with events `payment.captured`, `payment.failed`, `refund.processed` and `payment.dispute.*`.
   - E-signature vendor: `https://<domain>/api/webhooks/esign/<provider>`.
5. Firewall: add per-IP rate limits for `/i/*`, `/login` and `/api/*` (D-009).

## Release

Follow the checklist in `runbooks/deployment-rollback.md`, then `release-readiness.md` for the gates.
