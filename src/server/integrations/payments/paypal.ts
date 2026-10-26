import { minorToMajorString, parseMajorToMinor } from "@/modules/proposals/money";
import { AppError } from "@/server/errors";

import type { CheckoutInstructions, NormalizedPaymentEvent, PaymentProvider } from "./types";

const TIMEOUT_MS = 10_000;

/** Currencies a PayPal business account in India can receive (INR is domestic-only and not offered). */
export const PAYPAL_CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "SGD"] as const;

export type PayPalConfig = {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  env: "live" | "sandbox";
  merchantId: string | null;
  appUrl: string;
};

type Json = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function money(value: unknown): { amount_minor?: number; currency?: string } {
  const amount = obj(value);
  const minor = typeof amount.value === "string" ? parseMajorToMinor(amount.value) : null;
  return { amount_minor: minor ?? undefined, currency: str(amount.currency_code) };
}

function apiBase(env: PayPalConfig["env"]) {
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/** The buyer approval page for an order; stable, so a resumed attempt can rebuild it from the order ID. */
export function paypalApproveUrl(env: PayPalConfig["env"], orderId: string): string {
  const host = env === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
  return `${host}/checkoutnow?token=${encodeURIComponent(orderId)}`;
}

/** The capture ID a refund belongs to, from its "up" link. */
function captureIdFromLinks(links: unknown): string | undefined {
  for (const link of arr(links)) {
    const { rel, href } = obj(link);
    const match = rel === "up" && typeof href === "string" ? /\/captures\/([^/?#]+)/.exec(href) : null;
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Map a PayPal webhook event (or a server-side capture) to the internal event
 * model. PayPal amounts are decimal strings; every currency PayPal is offered
 * for here uses two decimals. Pure, for unit tests.
 */
export function normalizePayPalEvent(body: Json, merchantId: string | null): NormalizedPaymentEvent {
  const eventId = str(body.id) ?? "unknown";
  const type = str(body.event_type) ?? "unknown";
  const resource = obj(body.resource);
  const relatedOrder = str(obj(obj(resource.supplementary_data).related_ids).order_id);
  const account_id = str(obj(resource.payee).merchant_id) ?? merchantId ?? undefined;

  if (type === "PAYMENT.CAPTURE.COMPLETED") {
    return {
      eventId,
      type: "payment.succeeded",
      data: { account_id, provider_order_id: relatedOrder, provider_payment_id: str(resource.id), ...money(resource.amount) },
    };
  }
  if (type === "PAYMENT.CAPTURE.DENIED" || type === "PAYMENT.CAPTURE.DECLINED") {
    return {
      eventId,
      type: "payment.failed",
      data: { account_id, provider_order_id: relatedOrder, provider_payment_id: str(resource.id), failure_code: "PAYPAL_DENIED" },
    };
  }
  if (type === "PAYMENT.CAPTURE.REFUNDED") {
    // The resource is the refund; its capture is linked, and the event carries the refunded amount.
    return {
      eventId,
      type: "refund.processed",
      data: { account_id, provider_payment_id: captureIdFromLinks(resource.links), refund_id: str(resource.id), ...money(resource.amount) },
    };
  }
  if (type === "CUSTOMER.DISPUTE.CREATED" || type === "CUSTOMER.DISPUTE.RESOLVED") {
    const transaction = obj(arr(resource.disputed_transactions)[0]);
    const outcome = str(obj(resource.dispute_outcome).outcome_code);
    const normalized =
      type === "CUSTOMER.DISPUTE.CREATED"
        ? "dispute.opened"
        : outcome === "RESOLVED_SELLER_FAVOUR" || outcome === "CANCELED_BY_BUYER" || outcome === "DENIED"
          ? "dispute.won"
          : "dispute.lost";
    return {
      eventId,
      type: normalized,
      data: {
        account_id: merchantId ?? undefined,
        provider_payment_id: str(transaction.seller_transaction_id),
        dispute_id: str(resource.dispute_id),
        ...money(resource.dispute_amount),
      },
    };
  }
  // CHECKOUT.ORDER.APPROVED and the rest are recorded and ignored; the capture is what counts.
  return { eventId, type, data: { account_id } };
}

/**
 * A completed capture from the Orders API as a verified event. The response
 * came from PayPal over our authenticated server call, so it is as
 * trustworthy as a signed webhook; the webhook for the same capture is then a
 * duplicate (AT-015).
 */
export function captureToEvent(order: Json, merchantId: string | null): NormalizedPaymentEvent | null {
  const unit = obj(arr(order.purchase_units)[0]);
  const capture = obj(arr(obj(unit.payments).captures)[0]);
  const captureId = str(capture.id);
  if (!captureId || str(capture.status) !== "COMPLETED") return null;
  return {
    eventId: `capture:${captureId}`,
    type: "payment.succeeded",
    data: {
      account_id: str(obj(unit.payee).merchant_id) ?? merchantId ?? undefined,
      provider_order_id: str(order.id),
      provider_payment_id: captureId,
      ...money(capture.amount),
    },
  };
}

export type PayPalProvider = PaymentProvider & {
  /** Capture an approved order. Null when PayPal has not completed it (pending review, or not approved). */
  capture(orderId: string, paymentId: string): Promise<NormalizedPaymentEvent | null>;
};

export function paypalProvider(config: PayPalConfig): PayPalProvider {
  const base = apiBase(config.env);
  let cached: { token: string; expiresAt: number } | null = null;

  async function call(path: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new AppError("PROVIDER_UNAVAILABLE", { detail: `paypal ${label} request failed`, cause });
    }
  }

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const response = await call(
      "/v1/oauth2/token",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
      "token",
    );
    if (!response.ok) throw new AppError("PROVIDER_UNAVAILABLE", { detail: `paypal token HTTP ${response.status}` });
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new AppError("PROVIDER_UNAVAILABLE", { detail: "paypal token missing" });
    cached = { token: body.access_token, expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 300) * 1000 };
    return cached.token;
  }

  async function authed(path: string, body: unknown, label: string, requestId?: string): Promise<Response> {
    return call(
      path,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
          ...(requestId ? { "paypal-request-id": requestId } : {}),
        },
        body: JSON.stringify(body),
      },
      label,
    );
  }

  return {
    id: "paypal",

    async createOrder(input) {
      if (!(PAYPAL_CURRENCIES as readonly string[]).includes(input.currency)) {
        throw new AppError("VALIDATION_FAILED", { message: `PayPal isn't available for ${input.currency} invoices.` });
      }
      const returnUrl = `${config.appUrl}/portal/pay/paypal/return?payment=${input.paymentId}`;
      const response = await authed(
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: input.paymentId,
              custom_id: input.paymentId,
              invoice_id: input.paymentId,
              description: input.invoiceNumber ? `Atmors invoice ${input.invoiceNumber}` : "Atmors invoice",
              amount: { currency_code: input.currency, value: minorToMajorString(input.amountMinor) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: "Atmors",
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
                return_url: returnUrl,
                cancel_url: `${returnUrl}&cancelled=1`,
              },
            },
          },
        },
        "order",
        // Same attempt, same order: a retried request never creates a second one.
        `order-${input.paymentId}`,
      );
      if (!response.ok) {
        throw new AppError(response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE", { detail: `paypal order HTTP ${response.status}` });
      }
      const order = (await response.json()) as Json;
      const amount = money(obj(arr(order.purchase_units)[0]).amount);
      if (typeof order.id !== "string" || (amount.amount_minor !== undefined && amount.amount_minor !== input.amountMinor)) {
        throw new AppError("PROVIDER_UNAVAILABLE", { detail: "paypal order response did not match the request" });
      }
      return { providerOrderId: order.id };
    },

    checkout(input): CheckoutInstructions {
      return { kind: "redirect", url: paypalApproveUrl(config.env, input.providerOrderId) };
    },

    async capture(orderId, paymentId) {
      const response = await authed(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, "capture", `capture-${paymentId}`);
      if (response.status === 422) {
        // Already captured (a reload of the return page), or not approved yet: read the order instead.
        const lookup = await call(
          `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
          { headers: { authorization: `Bearer ${await accessToken()}` } },
          "order lookup",
        );
        return lookup.ok ? captureToEvent((await lookup.json()) as Json, config.merchantId) : null;
      }
      if (!response.ok) throw new AppError("PROVIDER_UNAVAILABLE", { detail: `paypal capture HTTP ${response.status}` });
      return captureToEvent((await response.json()) as Json, config.merchantId);
    },

    // PayPal signs with a certificate; their verification API checks it against our webhook ID.
    async verifyWebhook(rawBody, headers) {
      const header = (name: string) => headers.get(name) ?? "";
      if (!header("paypal-transmission-sig") || !header("paypal-transmission-id")) return false;
      const response = await authed(
        "/v1/notifications/verify-webhook-signature",
        {
          auth_algo: header("paypal-auth-algo"),
          cert_url: header("paypal-cert-url"),
          transmission_id: header("paypal-transmission-id"),
          transmission_sig: header("paypal-transmission-sig"),
          transmission_time: header("paypal-transmission-time"),
          webhook_id: config.webhookId,
          webhook_event: JSON.parse(rawBody),
        },
        "webhook verify",
      );
      if (!response.ok) return false;
      const body = (await response.json()) as { verification_status?: unknown };
      return body.verification_status === "SUCCESS";
    },

    parseWebhook(rawBody) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return null;
      }
      if (!body || typeof body !== "object" || typeof (body as Json).id !== "string") return null;
      const event = normalizePayPalEvent(body as Json, config.merchantId);
      return { ...event, eventId: event.eventId.slice(0, 200) };
    },
  };
}
