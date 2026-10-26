# Provider decision register

Source: PRD §10 and §20. Nothing provider-specific enters a domain model until its row is approved. Each provider sits behind an adapter.

| Decision | Status | Owner | Needed by | Evidence required before approval |
|---|---|---|---|---|
| E-signature vendor | Open (deliberately deferred). Adapter contract and sandbox built (`src/server/integrations/esign`) | Yazan + legal | Before agreements are sent to real clients | Legal review (India applicability), API and webhook coverage, audit certificate and export, signer UX, data handling and residency, cost, support, exit strategy, test results |
| AI provider / model | Open (deliberately deferred) | Yatharth | Before the Phase 5 production AI launch | Representative evaluation set, groundedness, prompt-injection results, latency, cost, data-use terms, rate limits, structured-output support |
| Scheduling implementation | Internal shared booking layer built (D-014); an external scheduler can plug in behind `SchedulingProvider` | Yatharth | Revisit if calendar sync is needed | Shared availability, owner routing, conflict prevention, timezone handling, reschedule and cancel, API access, cost, fallback |
| Payments provider / config | Razorpay adapter built, untested against live Razorpay until merchant keys exist; sandbox used in development | Yazan | Before taking real payments: run the PRD §10 provider tests (wrong amount, wrong currency, duplicate, delayed, failed, refund, outage) in Razorpay test mode | Merchant eligibility, methods and currencies, verified webhooks, refunds and disputes, fees, reconciliation, accounting requirements |
| Email | Resend proposed | Yatharth | Phase 2 (invitations) | Verified sender domain, delivery and bounce events, idempotent sends, cost |
| Hosting | Vercel proposed | Yatharth | Before the staging deploy | Environment separation, secrets, preview protection, rollback, region and data terms |
| Background jobs | Trigger.dev proposed | Yatharth | Phase 2/3 | Retries, deduplication, visibility, dead-letter and replay |
| Package payment rules | Policy model fixed; values set per agreement | Yazan | Phase 3 | Permitted schedule types and approval matrix |
| Activation policy defaults | Must be configured before live use | Yazan + Yatharth | Phase 4 | Which mix of executed contract, initial payment, onboarding review and manual review activates each service |
| Legal / privacy / accounting | External professional review required | Yazan | Before production | Contract templates, privacy notice, consent, retention, GST and invoicing, signature approach |

Owners are proposed from the PRD role table. Confirm them and set dates in the Phase 0 review.
