import "server-only";

import { randomUUID } from "node:crypto";

import { paymentStatusSchema, startPaymentResultSchema, type PaymentStatus } from "@/modules/billing/schema";
import { AppError, fromPostgrestError } from "@/server/errors";
import { ingestPaymentWebhook } from "@/server/integrations/ingest";
import { checkoutProviderId, paymentProvider, sandboxPayments } from "@/server/integrations/payments/registry";
import { SANDBOX_PAYMENT_ACCOUNT } from "@/server/integrations/payments/sandbox";
import type { CheckoutInstructions } from "@/server/integrations/payments/types";
import { logger } from "@/server/logger";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Start (or resume, for a retried request) a payment for an invoice. The
 * client's own session creates the attempt, so access, balance and amount are
 * checked by the database; the system identity then attaches the provider
 * order. The browser is never told the payment succeeded: only a verified
 * provider event can do that (AT-017).
 */
export async function startPayment(input: {
  invoiceId: string;
  amountMinor: number | null;
  idempotencyKey: string;
  correlationId: string;
}): Promise<{ paymentId: string; checkout: CheckoutInstructions }> {
  const providerId = checkoutProviderId();
  const provider = providerId ? paymentProvider(providerId) : null;
  if (!provider) throw new AppError("PROVIDER_UNAVAILABLE", { detail: "no payment provider configured" });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_start_payment", {
    p_invoice_id: input.invoiceId,
    p_provider: provider.id,
    p_amount_minor: input.amountMinor as number,
    p_idempotency_key: input.idempotencyKey,
    p_correlation_id: input.correlationId,
  });
  if (error) throw fromPostgrestError(error);
  const attempt = startPaymentResultSchema.parse(data);

  const checkoutFor = (orderId: string) =>
    provider.checkout({
      paymentId: attempt.payment_id,
      providerOrderId: orderId,
      amountMinor: attempt.amount_minor,
      currency: attempt.currency,
    });

  if (attempt.provider_order_id) return { paymentId: attempt.payment_id, checkout: checkoutFor(attempt.provider_order_id) };
  if (attempt.status !== "created") {
    throw new AppError("INVALID_STATE_TRANSITION", { message: "This payment attempt has ended. Start a new payment." });
  }

  const admin = createSupabaseAdminClient();
  let orderId: string;
  try {
    ({ providerOrderId: orderId } = await provider.createOrder({
      paymentId: attempt.payment_id,
      invoiceId: input.invoiceId,
      invoiceNumber: null,
      amountMinor: attempt.amount_minor,
      currency: attempt.currency,
    }));
  } catch (cause) {
    await admin.rpc("fail_payment_start", { p_payment_id: attempt.payment_id, p_error_code: "ORDER_CREATE_FAILED" });
    logger.error("payment.order_failed", { correlation_id: input.correlationId, provider: provider.id, cause });
    throw cause instanceof AppError ? cause : new AppError("PROVIDER_UNAVAILABLE", { cause });
  }

  const { error: attachError } = await admin.rpc("attach_payment_order", {
    p_payment_id: attempt.payment_id,
    p_provider_order_id: orderId,
  });
  if (attachError) throw fromPostgrestError(attachError);
  return { paymentId: attempt.payment_id, checkout: checkoutFor(orderId) };
}

/** The signed-in client's view of one payment attempt (NOT_FOUND unless theirs). */
export async function getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_payment_status", { p_payment_id: paymentId });
  if (error) throw fromPostgrestError(error);
  return paymentStatusSchema.parse(data);
}

/**
 * Sandbox checkout: emits a signed provider event through the real webhook
 * ingest path. "delayed" returns without an event, as when a provider's
 * webhook is late; the client keeps seeing "pending".
 */
export async function completeSandboxPayment(
  paymentId: string,
  outcome: "success" | "failure" | "delayed",
  correlationId: string,
): Promise<void> {
  const sandbox = sandboxPayments();
  if (!sandbox) throw new AppError("NOT_FOUND", { detail: "sandbox payments are disabled" });
  const status = await getPaymentStatus(paymentId);
  if (status.provider !== "sandbox" || !status.provider_order_id) {
    throw new AppError("INVALID_STATE_TRANSITION", { detail: "not a sandbox payment with an order" });
  }
  if (outcome === "delayed") return;

  const { rawBody, headers } = sandbox.signedEvent({
    id: `sbx_evt_${randomUUID()}`,
    type: outcome === "success" ? "payment.succeeded" : "payment.failed",
    data: {
      account_id: SANDBOX_PAYMENT_ACCOUNT,
      provider_order_id: status.provider_order_id,
      provider_payment_id: `sbx_pay_${paymentId}`,
      ...(outcome === "success"
        ? { amount_minor: status.amount_minor, currency: status.currency }
        : { failure_code: "SANDBOX_DECLINED" }),
    },
  });
  await ingestPaymentWebhook("sandbox", rawBody, headers, correlationId);
}
