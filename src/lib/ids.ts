/**
 * A fresh idempotency key for one user intent (a booking, a payment). Rendered
 * into the form so a retried or double-submitted request is recognised.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
