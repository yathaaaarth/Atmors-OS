"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { parseMajorToMinor } from "@/modules/proposals/money";
import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireSessionUser } from "@/server/auth/session";
import { completeSandboxPayment, getPaymentStatus, startPayment } from "@/server/billing";
import { fromPostgrestError } from "@/server/errors";
import { RATE_RULES, assertRateLimit } from "@/server/rate-limit";
import { createSupabaseServerClient } from "@/server/supabase/server";
import type { CheckoutInstructions } from "@/server/integrations/payments/types";

const paySchema = z.object({
  invoiceId: z.uuid(),
  idempotencyKey: z.uuid(),
  provider: z.string().regex(/^[a-z0-9_]{2,32}$/),
  amount: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return null;
      const minor = parseMajorToMinor(value);
      if (minor === null || minor <= 0) {
        ctx.addIssue({ code: "custom", message: "Enter a valid amount." });
        return z.NEVER;
      }
      return minor;
    }),
});

export type PayResult = { paymentId: string; checkout: CheckoutInstructions; returnUrl: string };

/** Payment needs a signed-in client (PRD §11); the database checks access and amount. */
export async function payInvoice(_: unknown, formData: FormData): Promise<ActionResult<PayResult>> {
  return runAction("payment.start", async (correlationId) => {
    await requireSessionUser();
    const values = parseInput(paySchema, formObject(formData, ["invoiceId", "idempotencyKey", "provider", "amount"]));
    const { paymentId, checkout } = await startPayment({
      invoiceId: values.invoiceId,
      provider: values.provider,
      amountMinor: values.amount,
      idempotencyKey: values.idempotencyKey,
      correlationId,
    });
    return { paymentId, checkout, returnUrl: `/portal/invoices/${values.invoiceId}?payment=${paymentId}` };
  });
}

const sandboxSchema = z.object({ paymentId: z.uuid(), outcome: z.enum(["success", "failure", "delayed"]) });

/** Development checkout only; disabled unless sandbox providers are enabled. */
export async function sandboxCheckout(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  let target: string | null = null;
  const result = await runAction("payment.sandbox_checkout", async (correlationId) => {
    await requireSessionUser();
    const values = parseInput(sandboxSchema, formObject(formData, ["paymentId", "outcome"]));
    await completeSandboxPayment(values.paymentId, values.outcome, correlationId);
    const status = await getPaymentStatus(values.paymentId);
    target = `/portal/invoices/${status.invoice_id}?payment=${values.paymentId}`;
    return null;
  });
  if (target) redirect(target);
  return result;
}

const transferSchema = z.object({
  invoiceId: z.uuid(),
  reference: z.string().trim().min(3, "Enter the transfer reference from your bank.").max(200),
  note: z.string().trim().max(1000).optional(),
});

/**
 * The client tells finance a bank transfer is on its way. This never marks the
 * invoice paid: finance records the payment once the money arrives.
 */
export async function reportTransfer(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("invoice.transfer_reported", async (correlationId) => {
    const user = await requireSessionUser();
    await assertRateLimit(RATE_RULES.publicForm, `user:${user.id}`);
    const values = parseInput(transferSchema, formObject(formData, ["invoiceId", "reference", "note"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("client_report_transfer", {
      p_invoice_id: values.invoiceId,
      p_reference: values.reference,
      p_note: values.note ?? (null as unknown as string),
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/portal/invoices/${values.invoiceId}`);
    return null;
  });
}
