import { z } from "zod";

import { formatMoney } from "./money";
import { proposalContentSchema, scheduleItemSchema } from "./schema";

/**
 * Shape of the client-safe projection returned by invitation_view,
 * client_proposal_view (private.client_proposal_json). Parsed defensively so a
 * schema drift fails loudly instead of rendering partial terms.
 */
const lineSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  quantity: z.number(),
  unit: z.string().nullable(),
  unit_amount_minor: z.number(),
  discount_minor: z.number(),
  tax_rate_bps: z.number(),
  billing_timing: z.string(),
  gross_minor: z.number(),
  net_minor: z.number(),
  tax_minor: z.number(),
  total_minor: z.number(),
});

export const clientVersionSchema = z.object({
  id: z.uuid(),
  version_number: z.number(),
  currency: z.string(),
  valid_until: z.string().nullable(),
  is_expired: z.boolean().nullable(),
  content: proposalContentSchema.partial(),
  payment_schedule: z.array(scheduleItemSchema),
  subtotal_minor: z.number(),
  discount_minor: z.number(),
  tax_minor: z.number(),
  total_minor: z.number(),
  line_items: z.array(lineSchema),
  content_hash: z.string().nullable(),
  change_summary: z.string().nullable(),
  sent_at: z.string().nullable(),
});

export type ClientVersion = z.infer<typeof clientVersionSchema>;

const proofSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["testimonial", "case_study"]),
  title: z.string(),
  quote: z.string().nullable(),
  author_name: z.string().nullable(),
  author_role: z.string().nullable(),
  company_name: z.string().nullable(),
  narrative: z.string().nullable(),
  metrics: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      kind: z.enum(["measured", "client_reported"]),
      period: z.string(),
      evidence_ref: z.string().optional(),
    }),
  ),
});

export type ClientProof = z.infer<typeof proofSchema>;

export const clientProposalSchema = z.object({
  proposal: z.object({
    id: z.uuid(),
    title: z.string(),
    status: z.string(),
    accepted_version_id: z.uuid().nullable().optional(),
    accepted_at: z.string().nullable().optional(),
    declined_at: z.string().nullable().optional(),
  }),
  organization_name: z.string().nullable(),
  prospect: z.object({ name: z.string(), company: z.string().nullable() }),
  version: clientVersionSchema.nullable(),
  previous_version: clientVersionSchema.nullable(),
  proof: z.array(proofSchema),
});

export type ClientProposal = z.infer<typeof clientProposalSchema>;

export const invitationViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("invalid") }),
  z.object({ state: z.literal("expired") }),
  z.object({ state: z.literal("revoked") }),
  z.object({ state: z.literal("redeemed") }),
  z.object({
    state: z.literal("valid"),
    organization_name: z.string().nullable(),
    prospect_name: z.string(),
    masked_email: z.string().nullable(),
    expires_at: z.string(),
    proposal: clientProposalSchema.nullable(),
  }),
]);

export type InvitationView = z.infer<typeof invitationViewSchema>;

/** Statuses in which a client may still accept, decline or ask for changes. */
export const OPEN_PROPOSAL_STATUSES = ["sent", "viewed", "negotiation"];

/**
 * Human-readable differences between the previously sent version and the
 * current one (PRD §5.2: clear comparison for revised proposals).
 */
export function compareVersions(previous: ClientVersion, current: ClientVersion): string[] {
  const changes: string[] = [];
  const money = (minor: number, currency: string) => formatMoney(minor, currency);

  if (previous.total_minor !== current.total_minor || previous.currency !== current.currency) {
    changes.push(
      `Total changed from ${money(previous.total_minor, previous.currency)} to ${money(current.total_minor, current.currency)}.`,
    );
  }

  const before = new Map(previous.line_items.map((line) => [line.title.toLowerCase(), line]));
  const after = new Map(current.line_items.map((line) => [line.title.toLowerCase(), line]));
  for (const [key, line] of after) {
    const old = before.get(key);
    if (!old) {
      changes.push(`Added “${line.title}” (${money(line.total_minor, current.currency)}).`);
    } else if (old.total_minor !== line.total_minor || old.quantity !== line.quantity) {
      changes.push(
        `“${line.title}” changed from ${money(old.total_minor, previous.currency)} to ${money(line.total_minor, current.currency)}.`,
      );
    }
  }
  for (const [key, line] of before) {
    if (!after.has(key)) changes.push(`Removed “${line.title}”.`);
  }

  if (previous.valid_until !== current.valid_until && current.valid_until) {
    changes.push(`Valid until is now ${current.valid_until}.`);
  }
  if (JSON.stringify(previous.payment_schedule) !== JSON.stringify(current.payment_schedule)) {
    changes.push("The payment schedule changed.");
  }
  const sections = ["summary", "scope", "deliverables", "timeline", "dependencies", "assumptions", "exclusions", "terms"] as const;
  const changedSections = sections.filter(
    (section) => JSON.stringify(previous.content[section] ?? null) !== JSON.stringify(current.content[section] ?? null),
  );
  if (changedSections.length > 0) {
    changes.push(`Updated sections: ${changedSections.join(", ")}.`);
  }
  return changes;
}
