import { z } from "zod";

const clientPaymentSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  amount_minor: z.number(),
  refunded_minor: z.number(),
  manual: z.boolean(),
  created_at: z.string(),
  succeeded_at: z.string().nullable(),
});

/** private.client_invoice_json */
export const clientInvoiceSchema = z.object({
  id: z.uuid(),
  invoice_number: z.string().nullable(),
  label: z.string(),
  currency: z.string(),
  total_minor: z.number(),
  paid_minor: z.number(),
  balance_minor: z.number(),
  status: z.string(),
  allow_partial: z.boolean(),
  issued_at: z.string().nullable(),
  due_at: z.string().nullable(),
  can_pay: z.boolean(),
  tax_minor: z.number().default(0),
  export: z.boolean().default(false),
  buyer: z
    .object({
      legal_name: z.string().nullable(),
      address: z.string().nullable(),
      tax_id: z.string().nullable(),
      country: z.string().nullable(),
    })
    .nullable()
    .optional(),
  seller: z
    .object({
      legal_name: z.string().nullable(),
      address: z.string().nullable(),
      gstin: z.string().nullable(),
      lut_number: z.string().nullable(),
      footer: z.string().nullable(),
    })
    .nullable()
    .optional(),
  bank_instructions: z.string().nullable().optional(),
  transfer_reported_at: z.string().nullable().optional(),
  payments: z.array(clientPaymentSchema),
});
export type ClientInvoice = z.infer<typeof clientInvoiceSchema>;

export const clientInvoiceListSchema = z.array(clientInvoiceSchema.omit({ payments: true }));

export const paymentStatusSchema = z.object({
  payment_id: z.uuid(),
  status: z.enum(["created", "pending", "succeeded", "failed", "cancelled", "refunded", "disputed"]),
  amount_minor: z.number(),
  currency: z.string(),
  provider: z.string(),
  provider_order_id: z.string().nullable(),
  invoice_id: z.uuid(),
  invoice_number: z.string().nullable(),
  invoice_status: z.string(),
  balance_minor: z.number(),
});
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const startPaymentResultSchema = z.object({
  payment_id: z.uuid(),
  amount_minor: z.number(),
  currency: z.string(),
  provider: z.string(),
  status: z.string(),
  provider_order_id: z.string().nullable(),
  replayed: z.boolean(),
});

/** A payment that has not reached a verified outcome yet (AT-017). */
export function isAwaitingConfirmation(status: PaymentStatus["status"]): boolean {
  return status === "created" || status === "pending";
}
