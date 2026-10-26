# Accidental data exposure or leaked secret

Treat both as incidents. Act first, investigate second, and keep notes with times.

## A secret leaked (key in a commit, log, chat or screenshot)

1. **Rotate immediately:**
   - Supabase: Project Settings → API Keys → roll the secret key.
   - Razorpay: regenerate the key and the webhook secret.
   - Resend and Anthropic: revoke the key.
   - `CRON_SECRET` and `SANDBOX_WEBHOOK_SECRET`: generate new values.
   Update the hosting environment and redeploy.
2. If it reached git: rotating is the fix. Rewriting history does not un-leak a pushed secret. The `secrets.test.ts` scan should catch most keys before commit.
3. Review Supabase logs and the audit log for use of the key in the exposure window.

## Someone saw data they shouldn't have

1. Contain:
   - Revoke the invitation link (prospect page).
   - Suspend the membership (Team) or revoke client access.
   - Remove the person from the workspace team.
2. Find the scope. The audit log records who accessed or changed what, including file downloads (`asset.downloaded`). Search by user, record or correlation ID.
3. If an authorization rule was wrong, fix it in a new migration with a failing test in `tests/security` first, and add it to the threat model.
4. Decide on notification with the legal adviser. Indian privacy obligations may require informing affected people; this is a release-gate item (PRD §11).
