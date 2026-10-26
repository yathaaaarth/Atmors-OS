import "server-only";

import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";

const askSchema = z.object({
  question: z.string().trim().min(2, "Ask a question.").max(1000, "Keep questions under 1,000 characters."),
  conversationId: z.uuid().optional(),
});

export function parseAsk(formData: FormData) {
  const values = parseInput(askSchema, formObject(formData, ["question", "conversationId"]));
  return { question: values.question, conversationId: values.conversationId ?? null };
}

export function parseActionId(formData: FormData): string {
  return parseInput(z.object({ actionId: z.uuid() }), formObject(formData, ["actionId"])).actionId;
}
