"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { proposalDraftSchema } from "@/modules/proposals/schema";
import { formObject } from "@/server/actions/form-data";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { fromPostgrestError, fromZodError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

function revalidateProposal(proposalId: string) {
  revalidatePath(`/dashboard/proposals/${proposalId}`);
  revalidatePath("/dashboard/proposals");
  revalidatePath("/dashboard");
}

export async function saveProposalDraft(
  proposalId: string,
  input: unknown,
): Promise<ActionResult<{ total_minor: number; requires_approval: boolean }>> {
  return runAction("proposal.save_draft", async (correlationId) => {
    await requireMemberContext();
    const values = parse(proposalDraftSchema, input);
    const supabase = await createSupabaseServerClient();
    // Line totals are derived by the database; only inputs are sent.
    const { data, error } = await supabase.rpc("save_proposal_draft", {
      p_version_id: values.versionId,
      p_title: values.title,
      p_currency: values.currency,
      p_valid_until: values.validUntil ?? (null as unknown as string),
      p_content: values.content,
      p_payment_schedule: values.paymentSchedule,
      p_line_items: values.lineItems.map((line) => ({
        title: line.title,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_amount_minor: line.unit_amount_minor,
        discount_minor: line.discount_minor,
        tax_rate_bps: line.tax_rate_bps,
        billing_timing: line.billing_timing,
      })),
      p_proof_ids: values.proofIds,
      p_non_standard_terms: values.nonStandardTerms,
      p_margin_exception: values.marginException,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateProposal(z.uuid().parse(proposalId));
    return { total_minor: data.total_minor, requires_approval: data.requires_approval };
  });
}

const versionActionSchema = z.object({ proposalId: z.uuid(), versionId: z.uuid() });

export async function submitVersion(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proposal.submit", async (correlationId) => {
    await requireMemberContext();
    const values = parse(versionActionSchema, formObject(formData, ["proposalId", "versionId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("submit_proposal_version", {
      p_version_id: values.versionId,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateProposal(values.proposalId);
    return null;
  });
}

const reviewSchema = versionActionSchema.extend({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
});

export async function reviewVersion(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proposal.review", async (correlationId) => {
    await requireMemberContext();
    const values = parse(reviewSchema, formObject(formData, ["proposalId", "versionId", "decision", "note"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("review_proposal_version", {
      p_version_id: values.versionId,
      p_decision: values.decision,
      p_note: values.note,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateProposal(values.proposalId);
    return null;
  });
}

export async function sendVersion(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proposal.send", async (correlationId) => {
    await requireMemberContext();
    const values = parse(versionActionSchema, formObject(formData, ["proposalId", "versionId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("send_proposal_version", {
      p_version_id: values.versionId,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateProposal(values.proposalId);
    return null;
  });
}

const revisionSchema = z.object({
  proposalId: z.uuid(),
  changeSummary: z.string().trim().min(3, "Summarise what will change.").max(2000),
});

export async function createRevision(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proposal.revise", async (correlationId) => {
    await requireMemberContext();
    const values = parse(revisionSchema, formObject(formData, ["proposalId", "changeSummary"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("create_proposal_revision", {
      p_proposal_id: values.proposalId,
      p_change_summary: values.changeSummary,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateProposal(values.proposalId);
    return null;
  });
}

const withdrawSchema = z.object({
  proposalId: z.uuid(),
  reason: z.string().trim().min(3, "Give a reason.").max(2000),
});

export async function withdrawProposal(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proposal.withdraw", async (correlationId) => {
    await requireMemberContext();
    const values = parse(withdrawSchema, formObject(formData, ["proposalId", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("withdraw_proposal", {
      p_proposal_id: values.proposalId,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateProposal(values.proposalId);
    return null;
  });
}
