# Deployment rollback (AT-035)

## Principles

- **Code rolls back; data moves forward.** Migrations are additive and never edited once applied. If a migration is wrong, fix it with a new migration (forward fix). Never restore a backup to undo a release (see [backup-restore.md](backup-restore.md)).
- Migrations are written to be compatible with the previous app version where possible (add columns or functions first, remove later), so the previous build keeps working against the new schema.
- Background work is idempotent, so a rollback that reruns a job does not repeat side effects.

## Rolling back the app

1. In Vercel → Deployments, pick the last good deployment and choose **Instant Rollback** (or `vercel rollback <url>`). It takes effect in seconds; committed business records are untouched.
2. Watch Operations and the logs for 15 minutes. Check:
   - error rates;
   - the dispatcher and daily jobs run;
   - webhooks return 200.
3. If the bad release included a migration that the old code can't work with, don't roll the code back. Write a forward-fix migration (or a compatibility view or function) and deploy that instead.

## Before each release (checklist)

- CI green: lint, types, unit and database tests, build, end-to-end, security (dev project), and dependency audit.
- New migrations reviewed for backward compatibility and applied to staging first (`npm run db:push` against the staging project).
- Provider configuration matches the environment (no sandbox providers in production: `ENABLE_SANDBOX_PROVIDERS` unset, no `sandbox` integration accounts).
- Note the current deployment URL so rollback is one click.
