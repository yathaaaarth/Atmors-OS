"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireSessionUser } from "@/server/auth/session";
import { completeInternalSignature, startInternalSignature } from "@/server/contracts";
import { RATE_RULES, assertRateLimit } from "@/server/rate-limit";

const startSchema = z.object({ contractId: z.uuid(), checksum: z.string().regex(/^[0-9a-f]{64}$/) });
const completeSchema = startSchema.extend({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email."),
  typedName: z.string().trim().min(2, "Type your full name to sign.").max(120),
  consent: z.literal("yes", { error: "Tick the box to confirm you agree to sign electronically." }),
});

/** Built-in signing for clients: the database checks this user is the named signer (AT-004). */
export async function requestSigningCode(formData: FormData): Promise<ActionResult<{ sentTo: string; devCode?: string }>> {
  return runAction("contract.signing_code", async (correlationId) => {
    const user = await requireSessionUser();
    await assertRateLimit(RATE_RULES.publicForm, `user:${user.id}`);
    const values = parseInput(startSchema, formObject(formData, ["contractId", "checksum"]));
    return startInternalSignature(values.contractId, values.checksum, correlationId);
  });
}

export async function signWithCode(_: unknown, formData: FormData): Promise<ActionResult<{ status: string; attemptsLeft?: number }>> {
  return runAction("contract.sign_with_code", async (correlationId) => {
    await requireSessionUser();
    const values = parseInput(completeSchema, formObject(formData, ["contractId", "checksum", "code", "typedName", "consent"]));
    const result = await completeInternalSignature(values, correlationId);
    if (result.status === "signed") {
      revalidatePath(`/portal/contracts/${values.contractId}`);
      revalidatePath("/portal");
    }
    return result;
  });
}
