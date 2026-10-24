import { z } from "zod";

export const PROOF_TRANSITIONS: Record<string, string[]> = {
  draft: ["permission_requested", "approved", "rejected"],
  permission_requested: ["approved", "rejected", "draft"],
  approved: ["published", "withdrawn"],
  published: ["withdrawn"],
  rejected: ["draft"],
  withdrawn: ["draft"],
};

/** Transitions that need proof.approve rather than proof.manage. */
export const APPROVER_TRANSITIONS = new Set(["approved", "published", "rejected"]);

export const metricSchema = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(60),
  kind: z.enum(["measured", "client_reported"]),
  period: z.string().trim().min(1, "Every metric needs a period.").max(120),
  evidence_ref: z.string().trim().min(1, "Every metric needs evidence.").max(500),
});

const optional = (max: number) => z.string().trim().max(max).optional().default("");

export const proofFormSchema = z
  .object({
    kind: z.enum(["testimonial", "case_study"]),
    title: z.string().trim().min(1, "Title is required.").max(200),
    quote: optional(2000),
    author_name: optional(120),
    author_role: optional(120),
    company_name: optional(200),
    narrative: optional(20000),
    metrics: z.array(metricSchema).max(20),
    audience_tags: z.array(z.string().trim().min(1).max(40)).max(20),
    source_evidence_ref: optional(1000),
    permission_evidence_ref: optional(1000),
    permission_expires_on: z.union([z.literal(""), z.iso.date()]).optional().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "testimonial" && !value.quote) {
      ctx.addIssue({ code: "custom", path: ["quote"], message: "A testimonial needs the quote." });
    }
    if (value.kind === "case_study" && !value.narrative) {
      ctx.addIssue({ code: "custom", path: ["narrative"], message: "A case study needs a narrative." });
    }
  });

export type ProofFormInput = z.input<typeof proofFormSchema>;
