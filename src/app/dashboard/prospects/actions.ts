"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { publicEnv } from "@/lib/env";
import { generateInvitationToken } from "@/modules/crm/invitation-token";
import { istDateTime, OUTREACH_CHANNELS, OUTREACH_DIRECTIONS, prospectFormSchema } from "@/modules/crm/schema";
import { CURRENCIES } from "@/modules/proposals/money";
import { formObject } from "@/server/actions/form-data";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { AppError, fromPostgrestError, fromZodError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

const PROSPECT_STATUSES = [
  "new",
  "contacted",
  "engaged",
  "proposal_sent",
  "converted",
  "declined",
  "disqualified",
  "archived",
] as const;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

function invitationUrl(token: string) {
  return new URL(`/i/${token}`, publicEnv().NEXT_PUBLIC_SITE_URL).toString();
}

// Every action below re-checks membership here and permissions again inside
// the RPC; the client is never trusted.

export async function createProspect(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("prospect.create", async (correlationId) => {
    const context = await requireMemberContext();
    const values = parse(prospectFormSchema, input);
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_prospect", {
      p_organization_id: context.organizationId,
      p_owner_user_id: values.owner_user_id ?? context.userId,
      p_name: values.name,
      p_company: values.company,
      p_email: values.email,
      p_contact_channel: values.contact_channel,
      p_contact_handle: values.contact_handle,
      p_source: values.source,
      p_target_service: values.target_service,
      p_notes: values.notes,
      p_next_action_at: values.next_action_at || undefined,
      p_correlation_id: correlationId,
    });
    if (error) {
      const appError = fromPostgrestError(error);
      if (appError.code === "CONFLICT") {
        throw new AppError("CONFLICT", {
          message: "A prospect with this email already exists.",
          fieldErrors: { email: ["Already used by another prospect."] },
        });
      }
      throw appError;
    }
    revalidatePath("/dashboard/prospects");
    return { id: data.id };
  });
}

export async function updateProspect(prospectId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("prospect.update", async (correlationId) => {
    await requireMemberContext();
    const id = parse(z.uuid(), prospectId);
    const values = parse(prospectFormSchema, input);
    const patch: Record<string, string | null> = {
      name: values.name,
      company: values.company ?? null,
      email: values.email ?? null,
      contact_channel: values.contact_channel,
      contact_handle: values.contact_handle ?? null,
      source: values.source ?? null,
      target_service: values.target_service ?? null,
      notes: values.notes ?? null,
      next_action_at: values.next_action_at || null,
    };
    if (values.owner_user_id) patch.owner_user_id = values.owner_user_id;

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_prospect", {
      p_prospect_id: id,
      p_patch: patch,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/dashboard/prospects/${id}`);
    return { id };
  });
}

const transitionSchema = z.object({
  prospectId: z.uuid(),
  to: z.enum(PROSPECT_STATUSES),
  reason: z.string().trim().min(3, "Give a short reason.").max(2000),
});

export async function transitionProspect(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("prospect.transition", async (correlationId) => {
    await requireMemberContext();
    const values = parse(transitionSchema, formObject(formData, ["prospectId", "to", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("transition_prospect", {
      p_prospect_id: values.prospectId,
      p_to: values.to,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/dashboard/prospects/${values.prospectId}`);
    return null;
  });
}

const outreachSchema = z.object({
  prospectId: z.uuid(),
  channel: z.enum(OUTREACH_CHANNELS),
  direction: z.enum(OUTREACH_DIRECTIONS),
  summary: z.string().trim().min(1, "Add a short summary.").max(4000),
  nextActionAt: istDateTime.optional(),
});

export async function logOutreach(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("prospect.log_outreach", async (correlationId) => {
    await requireMemberContext();
    const values = parse(
      outreachSchema,
      formObject(formData, ["prospectId", "channel", "direction", "summary", "nextActionAt"]),
    );
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("log_outreach", {
      p_prospect_id: values.prospectId,
      p_channel: values.channel,
      p_direction: values.direction,
      p_summary: values.summary,
      p_next_action_at: values.nextActionAt,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/dashboard/prospects/${values.prospectId}`);
    return null;
  });
}

const invitationSchema = z.object({
  prospectId: z.uuid(),
  proposalId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(30),
});

/** Returns the link exactly once; only its hash is stored. */
export async function createInvitation(_: unknown, formData: FormData): Promise<ActionResult<{ url: string }>> {
  return runAction("invitation.create", async (correlationId) => {
    await requireMemberContext();
    const values = parse(invitationSchema, formObject(formData, ["prospectId", "proposalId", "days"]));
    const { token, tokenHash } = generateInvitationToken();
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("create_invitation", {
      p_prospect_id: values.prospectId,
      // The SQL parameter is nullable (general-access invitation); generated types can't express that.
      p_proposal_id: values.proposalId ?? (null as unknown as string),
      p_token_hash: tokenHash,
      p_expires_in_days: values.days,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/dashboard/prospects/${values.prospectId}`);
    return { url: invitationUrl(token) };
  });
}

const manageInvitationSchema = z.object({
  prospectId: z.uuid(),
  invitationId: z.uuid(),
  action: z.enum(["mark_sent", "revoke", "extend", "replace"]),
  reason: z.string().trim().max(2000).optional(),
  days: z.coerce.number().int().min(1).max(30).optional(),
});

export async function manageInvitation(_: unknown, formData: FormData): Promise<ActionResult<{ url?: string }>> {
  return runAction("invitation.manage", async (correlationId) => {
    await requireMemberContext();
    const values = parse(
      manageInvitationSchema,
      formObject(formData, ["prospectId", "invitationId", "action", "reason", "days"]),
    );
    const supabase = await createSupabaseServerClient();

    if (values.action === "replace") {
      const { token, tokenHash } = generateInvitationToken();
      const { error } = await supabase.rpc("replace_invitation", {
        p_invitation_id: values.invitationId,
        p_new_token_hash: tokenHash,
        p_expires_in_days: values.days ?? 14,
        p_reason: values.reason,
        p_correlation_id: correlationId,
      });
      if (error) throw fromPostgrestError(error);
      revalidatePath(`/dashboard/prospects/${values.prospectId}`);
      return { url: invitationUrl(token) };
    }

    const { error } = await supabase.rpc("manage_invitation", {
      p_invitation_id: values.invitationId,
      p_action: values.action,
      p_reason: values.reason,
      p_extend_days: values.days,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/dashboard/prospects/${values.prospectId}`);
    return {};
  });
}

const newProposalSchema = z.object({
  prospectId: z.uuid(),
  title: z.string().trim().min(1, "Give the proposal a title.").max(200),
  currency: z.enum(CURRENCIES),
});

export async function createProposal(_: unknown, formData: FormData): Promise<ActionResult<{ id: string }>> {
  const result = await runAction("proposal.create", async (correlationId) => {
    await requireMemberContext();
    const values = parse(newProposalSchema, formObject(formData, ["prospectId", "title", "currency"]));
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_proposal", {
      p_prospect_id: values.prospectId,
      p_title: values.title,
      p_currency: values.currency,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    return { id: data.id };
  });
  // redirect() throws, so it must run outside runAction.
  if (result.ok) redirect(`/dashboard/proposals/${result.data.id}`);
  return result;
}
