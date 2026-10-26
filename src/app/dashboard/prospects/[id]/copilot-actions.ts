"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { askCopilot, confirmCopilotTask, type AssistantReply } from "@/server/ai/assistant";
import { parseActionId, parseAsk } from "@/server/ai/actions-shared";

const prospectSchema = z.object({ prospectId: z.uuid() });

export async function askCopilotAction(formData: FormData): Promise<ActionResult<AssistantReply>> {
  return runAction("ai.copilot_ask", async (correlationId) => {
    const { prospectId } = parseInput(prospectSchema, formObject(formData, ["prospectId"]));
    const { question, conversationId } = parseAsk(formData);
    return askCopilot(prospectId, question, conversationId, correlationId);
  });
}

/** Only the member who received the suggestion can confirm it, and only if they still may. */
export async function confirmCopilotAction(formData: FormData): Promise<ActionResult<null>> {
  return runAction("ai.copilot_confirm", async (correlationId) => {
    const { prospectId } = parseInput(prospectSchema, formObject(formData, ["prospectId"]));
    await confirmCopilotTask(parseActionId(formData), correlationId);
    revalidatePath(`/dashboard/prospects/${prospectId}`);
    revalidatePath("/dashboard");
    return null;
  });
}
