# Deployment guide (free tier)

The pilot runs entirely on free plans (decision D-028). What each service gives, what it costs you in limits, and how to set it up.

| Piece | Service (free plan) | Limits that matter | How we cover them |
|---|---|---|---|
| App | Vercel Hobby, region `sin1` (Singapore, next to the production database) | Hobby is for non-commercial use; crons only daily | Scheduler moved to GitHub Actions; move to Pro when the business uses it commercially at scale |
| Database, auth, files | Supabase Free: production in `ap-southeast-1` (Singapore), dev in `ap-south-1` (Mumbai) | 2 projects; 500 MB database; 1 GB files; pauses after 7 days idle; **no backups** | Dev project = development + testing; a second project = production. The 5-minute scheduler keeps production awake. Encrypted backups every 6 hours (database and files) through GitHub Actions |
| Scheduler | GitHub Actions (free for public repos) | Scheduled runs can lag a few minutes; disabled after 60 days without repo activity | Every job is idempotent; a late run only delays emails |
| Email | Resend Free | 3,000 per month, 100 per day | Enough for a pilot |
| Payments | Razorpay (about 2% domestic, about 3% international cards), PayPal (about 4.4% plus conversion), bank transfer (free) | Razorpay and PayPal need business accounts; international cards must be enabled on Razorpay | Clients choose; wire instructions are always shown when set; payments recorded manually for transfers (D-030) |
| E-signature | Built in (emailed code plus typed name) | Not an Aadhaar or qualified signature | Free; lawyer to confirm (D-029) |
| AI | Offline provider | Basic answers | Switch to Claude later if wanted (paid per use) |

## 1. Production database (Supabase)

1. Create a new project: name `atmors-prod`, region `ap-southeast-1 (Singapore)` (the current production project) or `ap-south-1 (Mumbai)`; keep `vercel.json` in the same region. Use a strong database password (keep it in a password manager).
2. Apply the schema from this repository:
   ```sh
   npx supabase link --project-ref <prod-ref>
   npx supabase db push --linked
   npx supabase link --project-ref arxsrxmuantnnsgpijek   # switch back to dev afterwards
   ```
3. Authentication:
   - Sign In / Providers: turn **off** "Allow new users to sign up".
   - URL Configuration: Site URL `https://<your-app-domain>`; Redirect URLs `https://<your-app-domain>/**`.
   - Multi-Factor: TOTP enabled.
   - Emails → Templates → **Magic Link**: link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` instead of the default `{{ .ConfirmationURL }}`. The default PKCE link only finishes in the browser that requested it, which fails when clients open email on their phone (D-032).
   - Emails → SMTP: host `smtp.resend.com`, port `465`, user `resend`, password = Resend API key, sender = your verified address.
4. Storage: check the `client-assets` bucket exists and is **private**.
5. Create the organization and staff (with production keys in a temporary `.env.prod.local`, deleted afterwards):
   `node --env-file=.env.prod.local scripts/bootstrap.ts --email … --name … --role cto_coo` (repeat per person).

## 2. App (Vercel Hobby)

1. Sign in to Vercel with GitHub and import `Atmors-OS`. Framework: Next.js. Root: the repository root.
2. Environment variables (Production):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<prod-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production publishable key |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-app-domain>` |
| `SUPABASE_SECRET_KEY` | production secret key |
| `CRON_SECRET` | 32+ random characters (also a GitHub secret, below) |
| `RESEND_API_KEY`, `EMAIL_FROM` | from Resend, e.g. `Atmors <hello@yourdomain>` |
| `REQUIRE_STAFF_MFA` | `true` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID`, `PAYPAL_ENV=live` | when PayPal is set up (section 5) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | when Razorpay is approved (section 5) |

   Do **not** set `ENABLE_SANDBOX_PROVIDERS`, `SANDBOX_WEBHOOK_SECRET` or any `*_PROVIDER=sandbox` in production.
3. Deploy. The app address is `https://<project>.vercel.app`, or add a custom domain (one DNS record, free).
4. Preview deployments (every branch) use the **dev** Supabase project: set the same variables for the Preview environment with dev values, plus the sandbox settings if you want test payments there.

## 3. Scheduler and backups (GitHub Actions)

Repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `APP_URL` | `https://<your-app-domain>` |
| `CRON_SECRET` | the same value as in Vercel |
| `BACKUP_DATABASE_URL` | Supabase → Connect → Session pooler connection string (with the database password) |
| `BACKUP_PASSPHRASE` | a long random passphrase; **also store it in your password manager**, without it backups can't be opened |
| `BACKUP_SUPABASE_URL`, `BACKUP_SUPABASE_SECRET_KEY` | production project URL and secret key, so uploaded files are backed up too (optional but recommended) |

Then Actions → "Scheduled jobs" → Run workflow (once, to check), and Actions → "Database backup" → Run workflow. Operations in the dashboard shows the job runs.

## 4. Getting paid from abroad

In the dashboard, Billing → **Invoice details**: registered name, address, GSTIN, LUT reference (file the LUT on the GST portal each financial year), and bank transfer instructions (account, IFSC, SWIFT code, and for USD wires the intermediary bank your bank gives you). Each agreement records the client's country; outside India, invoices print as export of services.

## 5. Payment providers (optional, when ready)

- **PayPal:** a PayPal Business account (India) linked to your bank account. On developer.paypal.com, create a REST app (sandbox first, then live). Add a webhook to `https://<your-app-domain>/api/webhooks/payments/paypal` with the five events in `.env.example`, and set the four `PAYPAL_*` variables. Then in Billing → Providers, add payments / `paypal` / your merchant ID. Indian rules require a purpose code for each received payment; set it for "software / consultancy services" in PayPal, and withdraw to your bank to get the FIRC.
- **Razorpay:** once the merchant account is approved, ask Razorpay to enable international cards. Webhook `https://<your-app-domain>/api/webhooks/payments/razorpay` (events: payment.captured, payment.failed, refund.processed, payment.dispute.*). Then add payments / `razorpay` / your account ID.
- **E-signature:** add esign / `internal` / `atmors` in Billing → Providers. That is all the built-in signer needs.

## 6. First checks after deploying

1. Sign in as a staff member; you are asked to set up an authenticator (MFA).
2. Create a test prospect and proposal, send yourself an invitation, check the email arrives.
3. Operations shows "dispatch notifications" and "daily checks" running.
4. Delete the test data (or keep it under a clearly named test prospect).

## When to move off free plans

- Vercel Pro (about $20/month): when the portal is used commercially beyond the pilot, or you need more than one region or team seats.
- Supabase Pro (about $25/month): for automatic daily backups, no pausing, and more space. Point-in-time recovery is an extra add-on.
- Nothing in the code changes; only the plan and the scheduler (Vercel Cron can then replace GitHub Actions).
