import { AppError } from "@/server/errors";

import { hmacSha256Hex, safeEqualHex, sha256Hex } from "../crypto";
import type { NormalizedPaymentEvent, PaymentProvider } from "./types";

const API_BASE = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 10_000;

type Entity = Record<string, unknown>;

function entity(body: Entity, key: string): Entity {
  const payload = (body.payload ?? {}) as Record<string, { entity?: Entity } | undefined>;
  return payload[key]?.entity ?? {};
}

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);
const int = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);

const DISPUTE_TYPES: Record<string, NormalizedPaymentEvent["type"]> = {
  "payment.dispute.created": "dispute.opened",
  "payment.dispute.won": "dispute.won",
  "payment.dispute.lost": "dispute.lost",
};

/**
 * Map a Razorpay webhook body to the internal event model. Razorpay amounts
 * are already integer minor units (paise). Pure, for unit tests.
 */
export function normalizeRazorpayEvent(body: Entity, eventId: string): NormalizedPaymentEvent {
  const event = str(body.event) ?? "unknown";
  const account_id = str(body.account_id);
  const payment = entity(body, "payment");

  if (event === "payment.captured") {
    return {
      eventId,
      type: "payment.succeeded",
      data: {
        account_id,
        provider_order_id: str(payment.order_id),
        provider_payment_id: str(payment.id),
        amount_minor: int(payment.amount),
        currency: str(payment.currency),
      },
    };
  }
  if (event === "payment.failed") {
    return {
      eventId,
      type: "payment.failed",
      data: {
        account_id,
        provider_order_id: str(payment.order_id),
        provider_payment_id: str(payment.id),
        failure_code: str(payment.error_code) ?? "FAILED",
      },
    };
  }
  if (event === "refund.processed") {
    const refund = entity(body, "refund");
    return {
      eventId,
      type: "refund.processed",
      data: {
        account_id,
        provider_payment_id: str(refund.payment_id),
        refund_id: str(refund.id),
        amount_minor: int(refund.amount),
        currency: str(refund.currency),
      },
    };
  }
  if (event in DISPUTE_TYPES) {
    const dispute = entity(body, "dispute");
    return {
      eventId,
      type: DISPUTE_TYPES[event],
      data: {
        account_id,
        provider_payment_id: str(dispute.payment_id),
        dispute_id: str(dispute.id),
        amount_minor: int(dispute.amount),
        currency: str(dispute.currency),
      },
    };
  }
  // order.paid duplicates payment.captured; everything else is recorded and ignored.
  return { eventId, type: event, data: { account_id } };
}

export function razorpayProvider(config: { keyId: string; keySecret: string; webhookSecret: string }): PaymentProvider {
  return {
    id: "razorpay",

    async createOrder(input) {
      let response: Response;
      try {
        response = await fetch(`${API_BASE}/orders`, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            amount: input.amountMinor,
            currency: input.currency,
            receipt: input.paymentId.replaceAll("-", "").slice(0, 40),
            notes: { payment_id: input.paymentId, invoice_id: input.invoiceId, invoice_number: input.invoiceNumber ?? "" },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        throw new AppError("PROVIDER_UNAVAILABLE", { detail: "razorpay order request failed", cause });
      }
      if (!response.ok) {
        throw new AppError(response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE", {
          detail: `razorpay order HTTP ${response.status}`,
        });
      }
      const order = (await response.json()) as { id?: unknown; amount?: unknown; currency?: unknown };
      if (typeof order.id !== "string" || order.amount !== input.amountMinor || order.currency !== input.currency) {
        throw new AppError("PROVIDER_UNAVAILABLE", { detail: "razorpay order response did not match the request" });
      }
      return { providerOrderId: order.id };
    },

    checkout(input) {
      return {
        kind: "razorpay",
        keyId: config.keyId,
        orderId: input.providerOrderId,
        amountMinor: input.amountMinor,
        currency: input.currency,
      };
    },

    // Razorpay signs the raw request body with the webhook secret (HMAC-SHA256, hex).
    verifyWebhook(rawBody, headers) {
      return safeEqualHex(hmacSha256Hex(config.webhookSecret, rawBody), headers.get("x-razorpay-signature"));
    },

    parseWebhook(rawBody, headers) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return null;
      }
      if (!body || typeof body !== "object") return null;
      const eventId = headers.get("x-razorpay-event-id") ?? `body:${sha256Hex(rawBody)}`;
      return normalizeRazorpayEvent(body as Entity, eventId.slice(0, 200));
    },
  };
}
