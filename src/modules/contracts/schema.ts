import { z } from "zod";

/** Client legal identity captured when an agreement is generated (PRD §5.5). */
export const legalIdentitySchema = z.object({
  client_legal_name: z.string().trim().min(2, "Enter the client's registered name.").max(200),
  client_address: z.string().trim().min(5, "Enter the registered address.").max(500),
  client_tax_id: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((value) => (value ? value.toUpperCase() : undefined)),
  signer_name: z.string().trim().min(2, "Who signs for the client?").max(120),
  signer_email: z.email("Enter the signer's email.").transform((value) => value.trim().toLowerCase()),
  client_country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Choose the client's country.")
    .default("IN"),
});
export type LegalIdentity = z.infer<typeof legalIdentitySchema>;

/** PRD §8 activation policy shape; configured per agreement, never globally. */
export const activationPolicySchema = z.object({
  required_contract_state: z.enum(["executed", "not_required"]),
  required_payment_items: z.array(z.number().int().min(0).max(11)).max(12),
  required_onboarding_state: z.enum(["approved", "not_required"]),
  required_manual_review: z.boolean(),
});
export type ActivationPolicy = z.infer<typeof activationPolicySchema>;

export function describeBlockingReason(reason: string, scheduleLabels: string[] = []): string {
  if (reason === "contract_not_executed") return "Agreement not yet executed";
  if (reason === "onboarding_not_approved") return "Onboarding not yet approved";
  if (reason === "manual_review_pending") return "Waiting for manual review";
  const match = /^payment_item_unpaid:(\d+)$/.exec(reason);
  if (match) {
    const label = scheduleLabels[Number(match[1])];
    return `${label ? `“${label}”` : `Instalment ${Number(match[1]) + 1}`} not yet paid`;
  }
  return reason.replaceAll("_", " ");
}

const signerSchema = z.object({
  role: z.enum(["client", "atmors"]),
  name: z.string(),
  status: z.enum(["pending", "signed", "declined"]),
  signed_at: z.string().nullable(),
  typed_name: z.string().nullable().optional(),
  method: z.string().nullable().optional(),
});

export const scheduleLineSchema = z.object({
  label: z.string(),
  amount_minor: z.number(),
  currency: z.string(),
  due_rule: z.enum(["on_acceptance", "on_signing", "on_date", "on_milestone"]),
  due_date: z.string().nullable(),
  milestone: z.string().nullable(),
  status: z.string(),
});

/** private.client_contract_json plus the viewer-specific signing flags. */
export const clientContractSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: z.string(),
  is_amendment: z.boolean(),
  provider: z.string().nullable().optional(),
  client_country: z.string().nullable().optional(),
  client_legal_name: z.string(),
  currency: z.string(),
  total_minor: z.number(),
  rendered_document: z.string(),
  checksum: z.string(),
  sent_at: z.string().nullable(),
  executed_at: z.string().nullable(),
  signers: z.array(signerSchema),
  schedule: z.array(scheduleLineSchema),
  can_sign: z.boolean(),
  signer_matches_user: z.boolean(),
});
export type ClientContract = z.infer<typeof clientContractSchema>;

export const clientContractListSchema = z.array(
  z.object({
    id: z.uuid(),
    title: z.string(),
    status: z.string(),
    sent_at: z.string().nullable(),
    executed_at: z.string().nullable(),
    is_amendment: z.boolean(),
  }),
);

export const DUE_RULE_LABELS: Record<z.infer<typeof scheduleLineSchema>["due_rule"], string> = {
  on_acceptance: "Due on acceptance",
  on_signing: "Due on signing",
  on_date: "Due on a date",
  on_milestone: "Due at a milestone",
};

export function describeDue(line: { due_rule: keyof typeof DUE_RULE_LABELS; due_date: string | null; milestone: string | null }): string {
  if (line.due_rule === "on_date" && line.due_date) return `Due ${line.due_date}`;
  if (line.due_rule === "on_milestone" && line.milestone) return `Due at: ${line.milestone}`;
  return DUE_RULE_LABELS[line.due_rule];
}
