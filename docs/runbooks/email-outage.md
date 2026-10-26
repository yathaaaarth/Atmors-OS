# Email outage

**You'll notice:** Operations → Failed emails grows; "Email could not be sent" tasks appear; the scheduled job "dispatch notifications" shows errors.

Important changes are always visible in the dashboard and portal, so an email outage delays messages but loses no information (PRD §10).

1. Check Operations → Scheduled jobs. If the dispatcher isn't running, check the scheduler (Vercel → Cron Jobs) and `CRON_SECRET`.
2. Check the email provider (Resend) status and API key. Messages back off automatically (about 2, 4, 8 and 16 minutes) and fail after five attempts.
3. When the provider is healthy again, press **Retry** on failed emails in Operations. Each message has a unique idempotency key, sent to the provider too, so a retry never produces a duplicate (AT-031).
4. Permanent rejections (bad address, 4xx) fail at once; fix the address on the prospect or agreement and ask the client to sign in to the portal.
5. Supabase Auth sign-in emails use Supabase's SMTP settings, not this outbox (D-010). If sign-in links stop arriving, check Supabase → Authentication → Emails → SMTP.
