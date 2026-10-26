"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { parseMajorToMinor } from "@/modules/proposals/money";
import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireSessionUser } from "@/server/auth/session";
import { completeSandboxPayment, getPaymentStatus, startPayment } from "@/server/billing";
import type { CheckoutInstructions } from "@/server/integrations/payments/types";

const paySchema = z.object({
  invoiceId: z.uuid(),
  idempotencyKey: z.uuid(),
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
    const values = parseInput(paySchema, formObject(formData, ["invoiceId", "idempotencyKey", "amount"]));
    const { paymentId, checkout } = await startPayment({
      invoiceId: values.invoiceId,
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
