# Webhook backlog or payment provider outage

**You'll notice:** clients see "Confirming your payment" for a long time; "Payment still pending after 24 hours" tasks appear; the provider's status page reports problems.

Clients are never shown success without a verified event, so a delay is safe but needs follow-up (AT-017).

1. Check the provider's status page and its webhook delivery log (Razorpay → Settings → Webhooks). Look for failed deliveries and their HTTP codes.
2. Check our side: `POST /api/webhooks/payments/razorpay` should return 200 (processed or duplicate) or 401 (bad signature). A 5xx means our database or deployment is failing; see the logs by `correlation_id`.
3. Once the cause is fixed, **redeliver** from the provider dashboard. Redelivery is safe: events are deduplicated by provider event ID, refunds and disputes by their own IDs (AT-015).
4. If the provider can't redeliver, confirm each payment's status in the provider dashboard. Then record verified payments manually on the invoice, with the provider payment ID as the reference.
5. If online payment must be paused, set `PAYMENTS_PROVIDER=none` and redeploy. The portal then tells clients to ask for bank details instead.

Signature webhooks (`/api/webhooks/esign/[provider]`) work the same way; see [signature-outage.md](signature-outage.md).
