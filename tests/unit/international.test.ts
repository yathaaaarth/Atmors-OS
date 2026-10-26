import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envelopeProviderId, esignProvider } from "@/server/integrations/esign/registry";
import {
  captureToEvent,
  normalizePayPalEvent,
  paypalApproveUrl,
  paypalProvider,
  type PayPalConfig,
} from "@/server/integrations/payments/paypal";
import { checkoutOptions } from "@/server/integrations/payments/registry";

const MERCHANT = "MERCHANT123";
const config: PayPalConfig = {
  clientId: "client",
  clientSecret: "secret",
  webhookId: "WH-CONFIG",
  env: "sandbox",
  merchantId: MERCHANT,
  appUrl: "https://clientos.example",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("PayPal event normalization", () => {
  it("maps a completed capture to payment.succeeded in minor units", () => {
    const event = normalizePayPalEvent(
      {
        id: "WH-1",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: "CAP-1",
          amount: { currency_code: "USD", value: "1250.50" },
          payee: { merchant_id: MERCHANT },
          supplementary_data: { related_ids: { order_id: "ORDER-1" } },
        },
      },
      MERCHANT,
    );
    expect(event).toEqual({
      eventId: "WH-1",
      type: "payment.succeeded",
      data: { account_id: MERCHANT, provider_order_id: "ORDER-1", provider_payment_id: "CAP-1", amount_minor: 125050, currency: "USD" },
    });
  });

  it("maps denials, refunds and disputes onto the capture", () => {
    expect(
      normalizePayPalEvent(
        { id: "WH-2", event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: "CAP-1", supplementary_data: { related_ids: { order_id: "ORDER-1" } } } },
        MERCHANT,
      ),
    ).toMatchObject({ type: "payment.failed", data: { provider_order_id: "ORDER-1", failure_code: "PAYPAL_DENIED" } });

    expect(
      normalizePayPalEvent(
        {
          id: "WH-3",
          event_type: "PAYMENT.CAPTURE.REFUNDED",
          resource: {
            id: "REF-1",
            amount: { currency_code: "USD", value: "10.00" },
            links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP-1" }],
          },
        },
        MERCHANT,
      ),
    ).toMatchObject({ type: "refund.processed", data: { provider_payment_id: "CAP-1", refund_id: "REF-1", amount_minor: 1000 } });

    const dispute = (eventType: string, outcome?: string) =>
      normalizePayPalEvent(
        {
          id: `WH-${eventType}-${outcome}`,
          event_type: eventType,
          resource: {
            dispute_id: "PP-D-1",
            disputed_transactions: [{ seller_transaction_id: "CAP-1" }],
            dispute_amount: { currency_code: "USD", value: "5.00" },
            ...(outcome ? { dispute_outcome: { outcome_code: outcome } } : {}),
          },
        },
        MERCHANT,
      );
    expect(dispute("CUSTOMER.DISPUTE.CREATED")).toMatchObject({
      type: "dispute.opened",
      data: { account_id: MERCHANT, provider_payment_id: "CAP-1", dispute_id: "PP-D-1", amount_minor: 500 },
    });
    expect(dispute("CUSTOMER.DISPUTE.RESOLVED", "RESOLVED_SELLER_FAVOUR").type).toBe("dispute.won");
    expect(dispute("CUSTOMER.DISPUTE.RESOLVED", "RESOLVED_BUYER_FAVOUR").type).toBe("dispute.lost");
  });

  it("records other events as unhandled and rejects malformed amounts", () => {
    expect(normalizePayPalEvent({ id: "WH-4", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} }, MERCHANT).type).toBe(
      "CHECKOUT.ORDER.APPROVED",
    );
    const event = normalizePayPalEvent(
      { id: "WH-5", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-2", amount: { currency_code: "USD", value: "1e3" } } },
      MERCHANT,
    );
    expect(event.data.amount_minor).toBeUndefined();
  });

  it("only treats a COMPLETED capture response as a payment", () => {
    const order = (status: string) => ({
      id: "ORDER-1",
      purchase_units: [{ payee: { merchant_id: MERCHANT }, payments: { captures: [{ id: "CAP-1", status, amount: { currency_code: "EUR", value: "99.99" } }] } }],
    });
    expect(captureToEvent(order("COMPLETED"), MERCHANT)).toEqual({
      eventId: "capture:CAP-1",
      type: "payment.succeeded",
      data: { account_id: MERCHANT, provider_order_id: "ORDER-1", provider_payment_id: "CAP-1", amount_minor: 9999, currency: "EUR" },
    });
    expect(captureToEvent(order("PENDING"), MERCHANT)).toBeNull();
    expect(captureToEvent({ id: "ORDER-1" }, MERCHANT)).toBeNull();
  });

  it("builds the buyer approval link for the right environment", () => {
    expect(paypalApproveUrl("sandbox", "ORDER 1")).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER%201");
    expect(paypalApproveUrl("live", "ORDER-1")).toBe("https://www.paypal.com/checkoutnow?token=ORDER-1");
  });
});

describe("PayPal adapter calls", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses INR before calling PayPal", async () => {
    await expect(
      paypalProvider(config).createOrder({ paymentId: "p", invoiceId: "i", invoiceNumber: null, amountMinor: 100, currency: "INR" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates an idempotent order for the exact amount", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ id: "ORDER-9", purchase_units: [{ amount: { currency_code: "USD", value: "1234.05" } }] }));
    const result = await paypalProvider(config).createOrder({
      paymentId: "pay-1",
      invoiceId: "inv-1",
      invoiceNumber: "ATM-0001",
      amountMinor: 123405,
      currency: "USD",
    });
    expect(result).toEqual({ providerOrderId: "ORDER-9" });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(init.headers["paypal-request-id"]).toBe("order-pay-1");
    const body = JSON.parse(init.body);
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "1234.05" });
    expect(body.payment_source.paypal.experience_context.return_url).toBe("https://clientos.example/portal/pay/paypal/return?payment=pay-1");
  });

  it("rejects an order whose amount PayPal changed", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ id: "ORDER-9", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] }));
    await expect(
      paypalProvider(config).createOrder({ paymentId: "p", invoiceId: "i", invoiceNumber: null, amountMinor: 200, currency: "USD" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("verifies webhooks through PayPal against the configured webhook ID", async () => {
    const headers = new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.paypal.com/cert",
      "paypal-transmission-id": "t-1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-10-26T00:00:00Z",
    });
    const provider = paypalProvider(config);
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ verification_status: "SUCCESS" }))
      .mockResolvedValueOnce(json({ verification_status: "FAILURE" }));
    await expect(provider.verifyWebhook('{"id":"WH-1"}', headers)).resolves.toBe(true);
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sent).toMatchObject({ webhook_id: "WH-CONFIG", transmission_id: "t-1", webhook_event: { id: "WH-1" } });
    await expect(provider.verifyWebhook('{"id":"WH-1"}', headers)).resolves.toBe(false);
    // Unsigned requests are rejected without asking PayPal.
    await expect(provider.verifyWebhook('{"id":"WH-1"}', new Headers())).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads the order after a repeated capture instead of failing", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ name: "UNPROCESSABLE_ENTITY" }, 422))
      .mockResolvedValueOnce(
        json({ id: "ORDER-1", purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } }] } }] }),
      );
    const event = await paypalProvider(config).capture("ORDER-1", "pay-1");
    expect(event).toMatchObject({ eventId: "capture:CAP-1", data: { amount_minor: 500, account_id: MERCHANT } });
    expect(fetchMock.mock.calls[1][1].headers["paypal-request-id"]).toBe("capture-pay-1");
  });
});

describe("provider selection", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://clientos.example");
    for (const name of ["PAYMENTS_PROVIDER", "ESIGN_PROVIDER", "ENABLE_SANDBOX_PROVIDERS", "RAZORPAY_KEY_ID", "PAYPAL_CLIENT_ID"]) vi.stubEnv(name, "");
    vi.stubEnv("VERCEL_ENV", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  const enablePayPal = () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH");
    vi.stubEnv("PAYPAL_MERCHANT_ID", MERCHANT);
  };
  const enableRazorpay = () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "k");
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "w".repeat(40));
  };

  it("offers nothing when no provider is configured", () => {
    expect(checkoutOptions("USD")).toEqual([]);
  });

  it("offers PayPal only for currencies it can receive", () => {
    enablePayPal();
    enableRazorpay();
    expect(checkoutOptions("USD").map((option) => option.provider)).toEqual(["razorpay", "paypal"]);
    expect(checkoutOptions("INR").map((option) => option.provider)).toEqual(["razorpay"]);
    expect(checkoutOptions().map((option) => option.provider)).toEqual(["razorpay", "paypal"]);
  });

  it("honours a pinned provider and never offers the sandbox in production", () => {
    enablePayPal();
    enableRazorpay();
    vi.stubEnv("PAYMENTS_PROVIDER", "paypal");
    expect(checkoutOptions("EUR").map((option) => option.provider)).toEqual(["paypal"]);
    vi.stubEnv("PAYMENTS_PROVIDER", "");
    vi.stubEnv("ENABLE_SANDBOX_PROVIDERS", "true");
    vi.stubEnv("SANDBOX_WEBHOOK_SECRET", "s".repeat(40));
    vi.stubEnv("VERCEL_ENV", "production");
    expect(checkoutOptions("USD").map((option) => option.provider)).not.toContain("sandbox");
  });

  it("signs with the built-in signer unless told otherwise", () => {
    expect(envelopeProviderId()).toBe("internal");
    expect(esignProvider("internal")?.verifyWebhook("{}", new Headers())).toBe(false);
    vi.stubEnv("ESIGN_PROVIDER", "docusign");
    expect(envelopeProviderId()).toBeNull();
  });
});
