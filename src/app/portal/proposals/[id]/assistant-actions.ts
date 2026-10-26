"use server";

import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { askSalesAssistant, confirmSalesHandoff, type AssistantReply } from "@/server/ai/assistant";
import { parseActionId, parseAsk } from "@/server/ai/actions-shared";

function scope(formData: FormData) {
  const { proposalId } = parseInput(z.object({ proposalId: z.uuid() }), formObject(formData, ["proposalId"]));
  return { kind: "client" as const, proposalId };
}

export async function askInPortal(formData: FormData): Promise<ActionResult<AssistantReply>> {
  return runAction("ai.sales_ask_portal", async (correlationId) => {
    const { question, conversationId } = parseAsk(formData);
    return askSalesAssistant(scope(formData), question, conversationId, correlationId);
  });
}

export async function confirmInPortal(formData: FormData): Promise<ActionResult<null>> {
  return runAction("ai.sales_handoff_portal", async (correlationId) => {
    await confirmSalesHandoff(scope(formData), parseActionId(formData), correlationId);
    return null;
  });
}
