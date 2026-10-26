"use server";

import { hashInvitationToken, isPlausibleInvitationToken } from "@/modules/crm/invitation-token";
import { runAction, type ActionResult } from "@/server/actions/result";
import { askSalesAssistant, confirmSalesHandoff, type AssistantReply } from "@/server/ai/assistant";
import { parseActionId, parseAsk } from "@/server/ai/actions-shared";
import { AppError } from "@/server/errors";

function scope(formData: FormData) {
  const token = formData.get("token");
  if (typeof token !== "string" || !isPlausibleInvitationToken(token)) throw new AppError("INVITATION_EXPIRED");
  return { kind: "token" as const, tokenHash: hashInvitationToken(token) };
}

/** Questions about the proposal behind this link; answers use only what the link already shows. */
export async function askWithToken(formData: FormData): Promise<ActionResult<AssistantReply>> {
  return runAction("ai.sales_ask_token", async (correlationId) => {
    const { question, conversationId } = parseAsk(formData);
    return askSalesAssistant(scope(formData), question, conversationId, correlationId);
  });
}

export async function confirmWithToken(formData: FormData): Promise<ActionResult<null>> {
  return runAction("ai.sales_handoff_token", async (correlationId) => {
    await confirmSalesHandoff(scope(formData), parseActionId(formData), correlationId);
    return null;
  });
}
