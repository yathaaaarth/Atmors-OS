# Runbooks

What to do when something goes wrong (PRD §16). Each one says how you'll notice, what to check, and how to recover without creating duplicate side effects.

| Runbook | When |
|---|---|
| [Payment mismatch](payment-mismatch.md) | A payment event is quarantined with `PAYMENT_MISMATCH`, `OVERPAYMENT` or `UNKNOWN_PAYMENT` |
| [Webhook backlog or provider outage](webhook-backlog.md) | Payments or signatures stop updating; provider events are delayed or failing |
| [E-signature provider outage](signature-outage.md) | Agreements can't be sent or signed |
| [Email outage](email-outage.md) | Failed emails pile up in Operations |
| [AI outage](ai-outage.md) | Assistants answer "isn't available right now" |
| [Accidental data exposure](accidental-exposure.md) | Someone saw data they shouldn't have, or a secret leaked |
| [Backup and restore](backup-restore.md) | Data loss or corruption; the scheduled restore exercise |
| [Deployment rollback](deployment-rollback.md) | A release breaks something |

Where to look first: **Dashboard → Operations** (failed emails, scheduled jobs, quarantined events, AI errors), **Billing → Provider exceptions**, the **Work queue** tasks, and the structured logs (every entry has a `correlation_id`; the same ID is in `audit_logs`, `workflow_events` and the error shown to users as "ref").
