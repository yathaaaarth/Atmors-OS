# Payment mismatch

**You'll notice:** a "Payment event quarantined" task in the work queue (finance), or a row under Billing → Provider exceptions.

The invoice was **not** changed. Quarantine means the event was recorded and set aside (AT-016).

1. Open Billing → Provider exceptions and note the error code and time.
   - `PAYMENT_MISMATCH`: amount, currency or merchant account differs from the payment attempt.
   - `OVERPAYMENT`: the invoice was already paid (for example, the client paid twice in two tabs).
   - `UNKNOWN_PAYMENT`: no attempt matches the order (an order made outside ClientOS, or a different environment's webhook).
   - `PROVIDER_NOT_ENABLED`: the provider account isn't enabled for the organization.
   - `SIGNATURE_INVALID`: forged or misconfigured webhook; see step 4.
2. Check the provider dashboard (Razorpay → Payments) for the payment ID and what was actually captured.
3. Fix the cause, then recover:
   - Wrong account configured: correct it under Billing → Providers, then press **Replay** on the event. Replay only works for verified events and is idempotent.
   - Genuine double payment: refund the duplicate in the provider dashboard. The refund webhook adjusts the history; nothing is erased.
   - Paid outside ClientOS (bank transfer): open the invoice and **Record a manual payment** with the reference. It is visibly marked as a manual override.
4. `SIGNATURE_INVALID` in volume means someone is probing the webhook, or the webhook secret changed. Compare `RAZORPAY_WEBHOOK_SECRET` with the provider dashboard. Forged events are never replayable.
5. Close the task with a note of what you did.

Never edit `payment_events`, `payments` or invoice balances directly. The database refuses edits to evidence, and balances are recomputed from payment records.
