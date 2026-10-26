"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { parseMajorToMinor } from "@/modules/proposals/money";
import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

function revalidateInvoice(invoiceId?: string) {
  if (invoiceId) revalidatePath(`/dashboard/billing/invoices/${invoiceId}`);
  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard");
}

const amountSchema = z
  .string()
  .transform((value, ctx) => {
    const minor = parseMajorToMinor(value);
    if (minor === null || minor <= 0) {
      ctx.addIssue({ code: "custom", message: "Enter an amount such as 59000 or 59,000.50." });
      return z.NEVER;
    }
    return minor;
  });

const manualSchema = z.object({
  invoiceId: z.uuid(),
  amount: amountSchema,
  reference: z.string().trim().min(3, "Add the bank or receipt reference.").max(200),
  reason: z.string().trim().min(3, "Explain why this is being reconciled manually.").max(2000),
});

/** Approved reconciliation: visibly marked as manual and audited with its reason. */
export async function recordManualPayment(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("payment.manual", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(manualSchema, formObject(formData, ["invoiceId", "amount", "reference", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("record_manual_payment", {
      p_invoice_id: values.invoiceId,
      p_amount_minor: values.amount,
      p_reference: values.reference,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateInvoice(values.invoiceId);
    return null;
  });
}

const voidSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(3, "Give a reason.").max(2000),
});

export async function voidInvoice(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("invoice.void", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(voidSchema, formObject(formData, ["invoiceId", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("void_invoice", {
      p_invoice_id: values.invoiceId,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateInvoice(values.invoiceId);
    return null;
  });
}

export async function reprocessPaymentEvent(_: unknown, formData: FormData): Promise<ActionResult<{ status: string }>> {
  return runAction("payment_event.reprocess", async (correlationId) => {
    await requireMemberContext();
    const { eventId } = parseInput(z.object({ eventId: z.uuid() }), formObject(formData, ["eventId"]));
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("reprocess_payment_event", {
      p_event_id: eventId,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateInvoice();
    return { status: data };
  });
}

export async function runBillingChecks(): Promise<ActionResult<{ issued: number; overdue: number }>> {
  return runAction("billing.run_checks", async (correlationId) => {
    const context = await requireMemberContext();
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("run_billing_checks", {
      p_organization_id: context.organizationId,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateInvoice();
    return data as { issued: number; overdue: number };
  });
}

const integrationSchema = z.object({
  kind: z.enum(["payments", "esign"]),
  provider: z.string().trim().regex(/^[a-z0-9_]{2,32}$/, "Use the provider's short ID, for example razorpay."),
  accountId: z.string().trim().min(1, "Enter the merchant or account ID.").max(200),
});

/** Enable a provider for this organization; events from other accounts are quarantined (AT-016). */
export async function configureIntegration(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("integration.configure", async (correlationId) => {
    const context = await requireMemberContext();
    const values = parseInput(integrationSchema, formObject(formData, ["kind", "provider", "accountId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("configure_integration_account", {
      p_organization_id: context.organizationId,
      p_kind: values.kind,
      p_provider: values.provider,
      p_account_id: values.accountId,
      p_active: formData.get("active") === "on",
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateInvoice();
    return null;
  });
}

const settingsSchema = z.object({
  legal_name: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([0-9A-Z]{15})?$/, "A GSTIN is 15 letters and digits.")
    .optional(),
  lut_number: z.string().trim().max(60).optional(),
  bank_instructions: z.string().trim().max(4000).optional(),
  invoice_footer: z.string().trim().max(1000).optional(),
});

/** Seller details printed on invoices, and the wire instructions clients see on unpaid invoices. */
export async function saveBillingSettings(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("billing.settings", async (correlationId) => {
    const context = await requireMemberContext();
    const values = parseInput(
      settingsSchema,
      formObject(formData, ["legal_name", "address", "gstin", "lut_number", "bank_instructions", "invoice_footer"]),
    );
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_billing_settings", {
      p_organization_id: context.organizationId,
      p_fields: values,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateInvoice();
    return null;
  });
}
