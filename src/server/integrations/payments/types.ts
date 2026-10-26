/**
 * Provider-independent payment adapter contract (PRD §10). Business rules
 * (matching, allocation, idempotency) live in the database ingest RPC; an
 * adapter only creates orders, verifies webhooks and normalizes events.
 */

export type NormalizedPaymentEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "refund.processed"
  | "dispute.opened"
  | "dispute.won"
  | "dispute.lost";

export type NormalizedPaymentData = {
  account_id?: string;
  provider_order_id?: string;
  provider_payment_id?: string;
  amount_minor?: number;
  currency?: string;
  refund_id?: string;
  dispute_id?: string;
  failure_code?: string;
};

export type NormalizedPaymentEvent = {
  eventId: string;
  /** A normalized type, or the provider's own type for events the system ignores. */
  type: NormalizedPaymentEventType | (string & {});
  data: NormalizedPaymentData;
};

export type CheckoutInstructions =
  | { kind: "redirect"; url: string }
  | { kind: "razorpay"; keyId: string; orderId: string; amountMinor: number; currency: string };

export type CreateOrderInput = {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amountMinor: number;
  currency: string;
};

export interface PaymentProvider {
  readonly id: string;
  /** Create an order for the exact amount and currency. Throws AppError on failure. */
  createOrder(input: CreateOrderInput): Promise<{ providerOrderId: string }>;
  checkout(input: { paymentId: string; providerOrderId: string; amountMinor: number; currency: string }): CheckoutInstructions;
  /** Authenticate the raw webhook body with the provider's documented method (some need an API call). */
  verifyWebhook(rawBody: string, headers: Headers): boolean | Promise<boolean>;
  /** Normalize a verified webhook; null when the body cannot be understood. */
  parseWebhook(rawBody: string, headers: Headers): NormalizedPaymentEvent | null;
}
