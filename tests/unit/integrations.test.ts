import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { safeEqualHex, sha256Hex } from "@/server/integrations/crypto";
import { sandboxEsignProvider } from "@/server/integrations/esign/sandbox";
import { normalizeRazorpayEvent, razorpayProvider } from "@/server/integrations/payments/razorpay";
import { SANDBOX_PAYMENT_ACCOUNT, sandboxPaymentProvider } from "@/server/integrations/payments/sandbox";

const rpc = vi.fn();
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));

const SECRET = "s".repeat(40);
const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

describe("signature helpers", () => {
  it("compares digests in constant time and rejects malformed input", () => {
    const digest = sha256Hex("hello");
    expect(safeEqualHex(digest, digest)).toBe(true);
    expect(safeEqualHex(digest, digest.toUpperCase())).toBe(true);
    expect(safeEqualHex(digest, digest.slice(0, -1))).toBe(false);
    expect(safeEqualHex(digest, "zz" + digest.slice(2))).toBe(false);
    expect(safeEqualHex(digest, null)).toBe(false);
  });
});

describe("Razorpay adapter", () => {
  const provider = razorpayProvider({ keyId: "rzp_test_x", keySecret: "k", webhookSecret: SECRET });
  const captured = {
    event: "payment.captured",
    account_id: "acc_123",
    payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 59000, currency: "INR" } } },
  };

  it("verifies the HMAC of the raw body", () => {
    const body = JSON.stringify(captured);
    expect(provider.verifyWebhook(body, new Headers({ "x-razorpay-signature": hmac(SECRET, body) }))).toBe(true);
    expect(provider.verifyWebhook(body, new Headers({ "x-razorpay-signature": hmac("wrong", body) }))).toBe(false);
    // Re-serializing changes the bytes; only the exact raw body verifies.
    expect(provider.verifyWebhook(JSON.stringify(captured, null, 2), new Headers({ "x-razorpay-signature": hmac(SECRET, body) }))).toBe(false);
    expect(provider.verifyWebhook(body, new Headers())).toBe(false);
  });

  it("normalizes captures, failures, refunds and disputes", () => {
    expect(normalizeRazorpayEvent(captured, "evt_1")).toEqual({
      eventId: "evt_1",
      type: "payment.succeeded",
      data: { account_id: "acc_123", provider_order_id: "order_1", provider_payment_id: "pay_1", amount_minor: 59000, currency: "INR" },
    });
    expect(
      normalizeRazorpayEvent(
        { event: "payment.failed", payload: { payment: { entity: { id: "pay_2", order_id: "order_2", error_code: "BAD_REQUEST_ERROR" } } } },
        "evt_2",
      ).data,
    ).toMatchObject({ provider_order_id: "order_2", failure_code: "BAD_REQUEST_ERROR" });
    expect(
      normalizeRazorpayEvent({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 9000 } } } }, "e").data,
    ).toMatchObject({ provider_payment_id: "pay_1", refund_id: "rfnd_1", amount_minor: 9000 });
    expect(normalizeRazorpayEvent({ event: "payment.dispute.lost", payload: { dispute: { entity: { id: "disp_1", payment_id: "pay_1" } } } }, "e").type).toBe(
      "dispute.lost",
    );
    expect(normalizeRazorpayEvent({ event: "order.paid" }, "e").type).toBe("order.paid");
  });

  it("never trusts non-integer amounts", () => {
    const tampered = { ...captured, payload: { payment: { entity: { ...captured.payload.payment.entity, amount: "59000" } } } };
    expect(normalizeRazorpayEvent(tampered, "e").data.amount_minor).toBeUndefined();
  });

  it("uses the event ID header and tolerates garbage bodies", () => {
    const body = JSON.stringify(captured);
    expect(provider.parseWebhook(body, new Headers({ "x-razorpay-event-id": "evt_hdr" }))?.eventId).toBe("evt_hdr");
    expect(provider.parseWebhook("not json", new Headers())).toBeNull();
  });
});

describe("sandbox adapters", () => {
  it("round-trips signed payment events and rejects tampering", () => {
    const sandbox = sandboxPaymentProvider(SECRET);
    const { rawBody, headers } = sandbox.signedEvent({
      id: "sbx_evt_1",
      type: "payment.succeeded",
      data: { account_id: SANDBOX_PAYMENT_ACCOUNT, provider_order_id: "sbx_order_1", amount_minor: 100, currency: "INR" },
    });
    expect(sandbox.verifyWebhook(rawBody, headers)).toBe(true);
    expect(sandbox.parseWebhook(rawBody, headers)).toMatchObject({ eventId: "sbx_evt_1", type: "payment.succeeded" });
    expect(sandbox.verifyWebhook(rawBody.replace('"amount_minor":100', '"amount_minor":1'), headers)).toBe(false);
    expect(sandboxPaymentProvider("x".repeat(40)).verifyWebhook(rawBody, headers)).toBe(false);
  });

  it("creates deterministic envelopes so retries do not double-send", async () => {
    const esign = sandboxEsignProvider(SECRET);
    const input = { contractId: "c-1", title: "T", documentText: "D", checksum: "0".repeat(64), signers: [] };
    expect(await esign.createEnvelope(input)).toEqual(await esign.createEnvelope(input));
    const { rawBody, headers } = esign.signedEvent({
      id: "sig_1",
      type: "signer.signed",
      document_id: "sbx_doc_c-1",
      occurred_at: "2026-10-26T10:00:00Z",
      signer: { role: "client", email: "a@b.test" },
    });
    expect(esign.verifyWebhook(rawBody, headers)).toBe(true);
    expect(esign.parseWebhook(rawBody, headers)).toMatchObject({
      providerDocumentId: "sbx_doc_c-1",
      data: { signer_role: "client", signer_email: "a@b.test" },
    });
  });
});

describe("webhook ingest (AT-014)", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_SANDBOX_PROVIDERS", "true");
    vi.stubEnv("SANDBOX_WEBHOOK_SECRET", SECRET);
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { status: "processed" }, error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes verified events to the database with their normalized data", async () => {
    const { ingestPaymentWebhook } = await import("@/server/integrations/ingest");
    const { rawBody, headers } = sandboxPaymentProvider(SECRET).signedEvent({
      id: "sbx_evt_ok",
      type: "payment.succeeded",
      data: { account_id: SANDBOX_PAYMENT_ACCOUNT, provider_order_id: "o", amount_minor: 5, currency: "INR" },
    });
    const outcome = await ingestPaymentWebhook("sandbox", rawBody, headers, "corr-ok-123");
    expect(outcome.httpStatus).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "ingest_payment_event",
      expect.objectContaining({ p_signature_verified: true, p_provider_event_id: "sbx_evt_ok", p_payload_hash: sha256Hex(rawBody) }),
    );
  });

  it("records forged events as unverified, without their claimed data, and answers 401", async () => {
    rpc.mockResolvedValue({ data: { status: "quarantined", error_code: "SIGNATURE_INVALID" }, error: null });
    const { ingestPaymentWebhook } = await import("@/server/integrations/ingest");
    const forged = JSON.stringify({ id: "evt_forged", type: "payment.succeeded", data: { amount_minor: 1 } });
    const outcome = await ingestPaymentWebhook("sandbox", forged, new Headers({ "x-sandbox-signature": "00".repeat(32) }), "corr-forged-1");
    expect(outcome).toMatchObject({ httpStatus: 401, status: "quarantined" });
    const args = rpc.mock.calls[0][1];
    expect(args).toMatchObject({ p_signature_verified: false, p_data: {} });
    expect(args.p_provider_event_id).toMatch(/^unverified:/); // a forgery cannot claim a real event ID
  });

  it("refuses providers that are not enabled here", async () => {
    vi.stubEnv("ENABLE_SANDBOX_PROVIDERS", "false");
    const { ingestPaymentWebhook } = await import("@/server/integrations/ingest");
    await expect(ingestPaymentWebhook("sandbox", "{}", new Headers(), "corr-off-123")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ingestPaymentWebhook("razorpay", "{}", new Headers(), "corr-off-123")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before touching the database", async () => {
    const { ingestPaymentWebhook } = await import("@/server/integrations/ingest");
    await expect(ingestPaymentWebhook("sandbox", "x".repeat(300 * 1024), new Headers(), "corr-big-1234")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
