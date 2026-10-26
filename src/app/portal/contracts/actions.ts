"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireSessionUser } from "@/server/auth/session";
import { signAsClient } from "@/server/contracts";
import { AppError } from "@/server/errors";

const signSchema = z.object({
  contractId: z.uuid(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  confirm: z.literal("yes", { error: "Tick the box to confirm you are signing this agreement." }),
});

/** AT-004: only a signed-in client whose email is the named signer can sign. */
export async function signContract(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("contract.client_sign", async (correlationId) => {
    await requireSessionUser();
    const values = parseInput(signSchema, formObject(formData, ["contractId", "checksum", "confirm"]));
    try {
      await signAsClient(values.contractId, values.checksum, correlationId);
    } catch (error) {
      if (error instanceof AppError && error.code === "VERSION_STALE") {
        throw new AppError("VERSION_STALE", { message: "This agreement changed since you opened it. Reload and review it again." });
      }
      throw error;
    }
    revalidatePath(`/portal/contracts/${values.contractId}`);
    revalidatePath("/portal");
    return null;
  });
}
