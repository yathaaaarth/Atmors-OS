# Backup and restore (AT-034)

## Objectives (proposed; approve before the pilot)

| | Target | How |
|---|---|---|
| RPO (data you can lose) | 24 hours on the free plan (5 minutes with Supabase PITR later) | Nightly encrypted dump by the "Database backup" GitHub Actions workflow |
| RTO (time to restore) | 4 hours | Restore the dump into a new Supabase project, repoint the app |
| Retention | 30 days of nightly dumps (workflow artifacts); download a monthly copy to keep longer | GitHub Actions artifacts, encrypted with `BACKUP_PASSPHRASE` |
| Restore owner | Yatharth (CTO/COO), with Yazan informed | |

**Files:** the nightly dump contains file records (names, owners, checksums) but not the uploaded files themselves, which live in Supabase Storage. On the free plan they are not backed up separately, so ask clients to keep their originals; Supabase Pro adds storage backups.

Financial and legal records may need longer retention once the accountant and legal review decide (PRD §11).

## Restore procedure

1. Declare the incident. Freeze changes: set the hosting deployment to maintenance, or pause the cron jobs so no emails or billing checks run against bad data.
2. Restore into a **new** Supabase project, so the damaged one stays available for investigation:
   - Download the chosen night's `clientos-db-backup` artifact from GitHub Actions and check it: `sha256sum -c clientos-<stamp>.sha256`.
   - Decrypt: `gpg --decrypt --output backup.dump clientos-<stamp>.dump.gpg` (asks for `BACKUP_PASSPHRASE`).
   - Restore: `pg_restore --no-owner --no-privileges --clean --if-exists --dbname "<new project's session-pooler URL>" backup.dump`, using pg_restore 17.
   - Delete the decrypted `backup.dump` afterwards. It contains client data.
   - Later, on Supabase Pro, use Database → Backups / PITR instead.
3. Apply any migrations newer than the backup: `npm run db:link -- --project-ref <new-ref>` then `npm run db:push`.
4. Point the app at the restored project: update `NEXT_PUBLIC_SUPABASE_URL`, the publishable key and `SUPABASE_SECRET_KEY`, then redeploy. Re-enable storage bucket contents: Supabase Storage is backed up separately, so restore `client-assets` from its backup if it was affected.
5. Reconcile external systems before re-enabling jobs (see "Why a restore creates no duplicate side effects" below):
   - Payments: compare Razorpay payments since the restore point with `payments`, then redeliver webhooks from the provider for the gap. Already-recorded events are ignored as duplicates.
   - Signatures: redeliver provider events since the restore point.
   - Emails: messages marked `sent` stay sent. Messages enqueued after the restore point are recreated only if their business event happens again, and their idempotency keys stop duplicates.
6. Re-enable cron jobs and lift maintenance. Record the times and outcome below.

## Why a restore creates no duplicate side effects

- Outgoing email is an outbox keyed by business event (`invoice_issued:<id>`, …) and the same key is sent to the email provider as its idempotency key.
- Incoming provider events are deduplicated by provider event ID; refunds and disputes also by their own IDs.
- Billing checks, reminders and activation evaluations are idempotent (dedupe keys on tasks, one live invoice per instalment).
- Agreements are sent with a deterministic envelope ID per agreement.

## Restore exercise log

Run the exercise at least quarterly, and once before the pilot, against a **copy** (never the production project): restore the latest backup to a scratch project, run `npm run test:security` against it (fixture data), and spot-check one client's records end to end.

| Date | Backup point | Restored to | Duration | Checks | Result | By |
|---|---|---|---|---|---|---|
| _not yet run: do it once the backup workflow has produced its first dump_ | | | | | | |
