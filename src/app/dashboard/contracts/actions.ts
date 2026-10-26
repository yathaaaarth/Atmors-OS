"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { activationPolicySchema, legalIdentitySchema } from "@/modules/contracts/schema";
import { formObject, formString } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { assertCan } from "@/server/authorization/permissions";
import { requireMemberContext } from "@/server/authorization/member-context";
import { completeInternalSignature, countersign, sendContractForSignature, startInternalSignature } from "@/server/contracts";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

function revalidateContract(contractId: string) {
  revalidatePath(`/dashboard/contracts/${contractId}`);
  revalidatePath("/dashboard/contracts");
  revalidatePath("/dashboard");
}

const generateSchema = z.object({
  proposalId: z.uuid(),
  templateId: z.uuid({ error: "Choose a template." }),
  countersignerId: z.uuid({ error: "Choose who signs for Atmors." }),
  legal: legalIdentitySchema,
  policy: activationPolicySchema,
});

/** Generate the agreement from the proposal's accepted version (AT-012). */
export async function generateContract(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  let target: string | null = null;
  const result = await runAction("contract.generate", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "contracts.manage");
    const values = parseInput(generateSchema, {
      ...formObject(formData, ["proposalId", "templateId", "countersignerId"]),
      legal: formObject(formData, ["client_legal_name", "client_address", "client_tax_id", "client_country", "signer_name", "signer_email"]),
      policy: {
        required_contract_state: formData.get("requireExecuted") === "on" ? "executed" : "not_required",
        required_payment_items: formData.getAll("requiredItem").map((value) => Number(value)),
        required_onboarding_state: formData.get("requireOnboarding") === "on" ? "approved" : "not_required",
        required_manual_review: formData.get("requireReview") === "on",
      },
    });
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("generate_contract", {
      p_proposal_id: values.proposalId,
      p_template_id: values.templateId,
      p_legal: values.legal,
      p_countersigner_user_id: values.countersignerId,
      p_activation_policy: values.policy,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/dashboard/proposals/${values.proposalId}`);
    target = `/dashboard/contracts/${data.id}`;
    return null;
  });
  if (target) redirect(target);
  return result;
}

const contractIdSchema = z.object({ contractId: z.uuid() });

const transitionSchema = contractIdSchema.extend({
  action: z.enum(["mark_ready", "void"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function transitionContract(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract.transition", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(transitionSchema, formObject(formData, ["contractId", "action", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("transition_contract", {
      p_contract_id: values.contractId,
      p_action: values.action,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateContract(values.contractId);
    return null;
  });
}

export async function sendContract(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract.send", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "contracts.manage");
    const { contractId } = parseInput(contractIdSchema, formObject(formData, ["contractId"]));
    await sendContractForSignature(contractId, correlationId);
    revalidateContract(contractId);
    return null;
  });
}

const checksumSchema = contractIdSchema.extend({ checksum: z.string().regex(/^[0-9a-f]{64}$/) });

export async function countersignContract(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract.countersign", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "contracts.manage");
    const values = parseInput(checksumSchema, formObject(formData, ["contractId", "checksum"]));
    await countersign(values.contractId, values.checksum, correlationId);
    revalidateContract(values.contractId);
    return null;
  });
}

const amendSchema = contractIdSchema.extend({
  reason: z.string().trim().min(3, "Give a reason.").max(2000),
  amendmentText: z.string().trim().min(10, "Describe the change (10+ characters).").max(20000),
});

/** AT-013: an executed agreement changes only through a linked amendment. */
export async function amendContract(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  let target: string | null = null;
  const result = await runAction("contract.amend", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(amendSchema, formObject(formData, ["contractId", "reason", "amendmentText"]));
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_contract_amendment", {
      p_contract_id: values.contractId,
      p_reason: values.reason,
      p_amendment_text: values.amendmentText,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateContract(values.contractId);
    target = `/dashboard/contracts/${data.id}`;
    return null;
  });
  if (target) redirect(target);
  return result;
}

export async function evaluateActivation(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract.evaluate_activation", async (correlationId) => {
    await requireMemberContext();
    const { contractId } = parseInput(contractIdSchema, formObject(formData, ["contractId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("evaluate_contract_activation", {
      p_contract_id: contractId,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateContract(contractId);
    return null;
  });
}

const reviewSchema = contractIdSchema.extend({ note: z.string().trim().min(3, "Add a short review note.").max(2000) });

export async function recordActivationReview(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract.activation_review", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(reviewSchema, formObject(formData, ["contractId", "note"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("record_activation_review", {
      p_contract_id: values.contractId,
      p_note: values.note,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateContract(values.contractId);
    return null;
  });
}

const issueSchema = contractIdSchema.extend({
  itemId: z.uuid(),
  dueInDays: z.coerce.number().int().min(0).max(90),
});

export async function issueInvoice(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("invoice.issue", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(issueSchema, formObject(formData, ["contractId", "itemId", "dueInDays"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("issue_invoice_for_item", {
      p_item_id: values.itemId,
      p_due_in_days: values.dueInDays,
      p_allow_partial: formData.get("allowPartial") === "on",
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateContract(values.contractId);
    revalidatePath("/dashboard/billing");
    return null;
  });
}

const templateSchema = z.object({
  organizationId: z.uuid(),
  key: z.string().trim().regex(/^[a-z0-9-]{2,64}$/, "Use lowercase letters, numbers and dashes."),
  name: z.string().trim().min(1).max(200),
  body: z.string().min(50, "The template body is too short.").max(100_000),
});

export async function saveTemplate(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract_template.save", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "contracts.templates");
    const raw = formData.get("body");
    const values = parseInput(templateSchema, {
      ...formObject(formData, ["key", "name"]),
      organizationId: context.organizationId,
      body: typeof raw === "string" ? raw.replace(/\r\n/g, "\n") : undefined,
    });
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_contract_template", {
      p_organization_id: values.organizationId,
      p_key: values.key,
      p_name: values.name,
      p_body: values.body,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/contracts/templates");
    return null;
  });
}

const templateStateSchema = z.object({
  templateId: z.uuid(),
  reviewStatus: z.enum(["pending", "approved", "rejected"]),
  note: z.string().trim().max(2000).optional(),
});

export async function setTemplateState(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract_template.state", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(templateStateSchema, formObject(formData, ["templateId", "reviewStatus", "note"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_contract_template_state", {
      p_template_id: values.templateId,
      p_active: formString(formData, "active") === "on",
      p_review_status: values.reviewStatus,
      p_note: values.note,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/contracts/templates");
    return null;
  });
}

const signStartSchema = z.object({ contractId: z.uuid(), checksum: z.string().regex(/^[0-9a-f]{64}$/) });

/** Built-in countersignature: the named Atmors signer, in an MFA-verified session. */
export async function requestCountersignCode(formData: FormData): Promise<ActionResult<{ sentTo: string; devCode?: string }>> {
  return runAction("contract.countersign_code", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "contracts.manage");
    const values = parseInput(signStartSchema, formObject(formData, ["contractId", "checksum"]));
    return startInternalSignature(values.contractId, values.checksum, correlationId);
  });
}

const signCompleteSchema = signStartSchema.extend({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email."),
  typedName: z.string().trim().min(2, "Type your full name to sign.").max(120),
  consent: z.literal("yes", { error: "Tick the box to confirm." }),
});

export async function countersignWithCode(_: unknown, formData: FormData): Promise<ActionResult<{ status: string; attemptsLeft?: number }>> {
  return runAction("contract.countersign_with_code", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "contracts.manage");
    const values = parseInput(signCompleteSchema, formObject(formData, ["contractId", "checksum", "code", "typedName", "consent"]));
    const result = await completeInternalSignature(values, correlationId);
    if (result.status === "signed") revalidateContract(values.contractId);
    return result;
  });
}
