import { z } from "zod";

import { CURRENCIES } from "./money";

const text = (max: number) => z.string().trim().max(max);
const list = z.array(z.string().trim().min(1).max(1000)).max(50);

export const proposalContentSchema = z.object({
  summary: text(4000),
  scope: text(10000),
  deliverables: list,
  timeline: text(4000),
  dependencies: list,
  assumptions: list,
  exclusions: list,
  terms: text(20000),
});

export type ProposalContent = z.infer<typeof proposalContentSchema>;

export const EMPTY_CONTENT: ProposalContent = {
  summary: "",
  scope: "",
  deliverables: [],
  timeline: "",
  dependencies: [],
  assumptions: [],
  exclusions: [],
  terms: "",
};

export const BILLING_TIMINGS = ["upfront", "milestone", "monthly", "on_completion"] as const;
export const BILLING_TIMING_LABELS: Record<(typeof BILLING_TIMINGS)[number], string> = {
  upfront: "Upfront",
  milestone: "On milestone",
  monthly: "Monthly",
  on_completion: "On completion",
};

export const lineItemSchema = z.object({
  title: z.string().trim().min(1, "Give the line a title.").max(200),
  description: text(4000).optional(),
  quantity: z.number().positive().max(1_000_000).multipleOf(0.01),
  unit: text(40).optional(),
  unit_amount_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  discount_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tax_rate_bps: z.number().int().min(0).max(10_000),
  billing_timing: z.enum(BILLING_TIMINGS),
});

export type LineItemInput = z.infer<typeof lineItemSchema>;

export const SCHEDULE_DUE = ["on_acceptance", "on_signing", "on_date", "on_milestone"] as const;
export const SCHEDULE_DUE_LABELS: Record<(typeof SCHEDULE_DUE)[number], string> = {
  on_acceptance: "On acceptance",
  on_signing: "On signing",
  on_date: "On a date",
  on_milestone: "On a milestone",
};

const scheduleBase = {
  label: z.string().trim().min(1).max(120),
  due: z.enum(SCHEDULE_DUE),
  due_date: z.iso.date().optional(),
  milestone: text(200).optional(),
};

export const scheduleItemSchema = z.discriminatedUnion("basis", [
  z.object({ ...scheduleBase, basis: z.literal("percent"), percent_bps: z.number().int().min(1).max(10_000) }),
  z.object({ ...scheduleBase, basis: z.literal("fixed"), amount_minor: z.number().int().positive() }),
]);

export const proposalDraftSchema = z.object({
  versionId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  currency: z.enum(CURRENCIES),
  validUntil: z.iso.date().nullable(),
  content: proposalContentSchema,
  paymentSchedule: z.array(scheduleItemSchema).max(12),
  lineItems: z.array(lineItemSchema).max(100),
  proofIds: z.array(z.uuid()).max(20),
  nonStandardTerms: z.boolean(),
  marginException: z.boolean(),
});

export type ProposalDraftInput = z.infer<typeof proposalDraftSchema>;
