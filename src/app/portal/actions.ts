"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireSessionUser } from "@/server/auth/session";
import { AppError, fromPostgrestError, fromZodError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

const acceptSchema = z.object({
  proposalId: z.uuid(),
  versionId: z.uuid(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirm: z.literal("yes", { error: "Tick the box to confirm you accept these terms." }),
});

/** AT-007: acceptance is bound to the exact version and terms the client saw. */
export async function acceptProposal(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proposal.accept", async (correlationId) => {
    await requireSessionUser();
    const parsed = acceptSchema.safeParse(formObject(formData, ["proposalId", "versionId", "contentHash", "confirm"]));
    if (!parsed.success) throw fromZodError(parsed.error);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("accept_proposal", {
      p_proposal_id: parsed.data.proposalId,
      p_version_id: parsed.data.versionId,
      p_content_hash: parsed.data.contentHash,
      p_correlation_id: correlationId,
    });
    if (error) {
      const appError = fromPostgrestError(error);
      if (appError.code === "VERSION_STALE") {
        throw new AppError("VERSION_STALE", {
          message: "This proposal was updated since you opened it. Please review the latest version before accepting.",
        });
      }
      throw appError;
    }
    revalidatePath(`/portal/proposals/${parsed.data.proposalId}`);
    revalidatePath("/portal");
    return null;
  });
}

const respondSchema = z.object({
  proposalId: z.uuid(),
  response: z.enum(["decline", "request_changes"]),
  message: z.string().trim().max(2000).optional(),
});

export async function respondToProposal(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("proposal.client_respond", async (correlationId) => {
    await requireSessionUser();
    const parsed = respondSchema.safeParse(formObject(formData, ["proposalId", "response", "message"]));
    if (!parsed.success) throw fromZodError(parsed.error);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("client_respond_to_proposal", {
      p_proposal_id: parsed.data.proposalId,
      p_response: parsed.data.response,
      p_message: parsed.data.message,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath(`/portal/proposals/${parsed.data.proposalId}`);
    return null;
  });
}
