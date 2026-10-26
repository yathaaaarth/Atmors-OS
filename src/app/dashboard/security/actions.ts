"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { getMemberContext } from "@/server/authorization/member-context";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { createSupabaseServerClient } from "@/server/supabase/server";

/** Enrollment runs before AAL2 exists, so it checks membership directly (not requireMemberContext). */
async function requireMember() {
  const result = await getMemberContext();
  if (result.status !== "member") throw new AppError(result.status === "unauthenticated" ? "UNAUTHENTICATED" : "FORBIDDEN");
  return result.context;
}

export async function startTotpEnrollment(): Promise<ActionResult<{ factorId: string; qrCode: string; secret: string }>> {
  return runAction("mfa.enroll_start", async () => {
    await requireMember();
    const supabase = await createSupabaseServerClient();
    // Drop half-finished enrollments so the friendly name stays unique.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const factor of factors?.all ?? []) {
      if (factor.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    if (error || !data) {
      logger.warn("mfa.enroll_failed", { message: error?.message });
      throw new AppError("PROVIDER_UNAVAILABLE", { message: "Couldn't start authenticator setup. Try again." });
    }
    return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
  });
}

const verifySchema = z.object({
  factorId: z.uuid(),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
  next: z.string().optional(),
});

/** Verifies a code: completes enrollment, or upgrades this session to AAL2. */
export async function verifyTotp(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("mfa.verify", async () => {
    const context = await requireMember();
    const values = parseInput(verifySchema, formObject(formData, ["factorId", "code", "next"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: values.factorId, code: values.code });
    if (error) throw new AppError("VALIDATION_FAILED", { message: "That code didn't match. Check the time on your device and try again." });
    logger.info("mfa.verified", { user_id: context.userId });
    revalidatePath("/dashboard", "layout");
    return null;
  });
}

export async function removeFactor(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("mfa.unenroll", async () => {
    await requireMember();
    if (process.env.REQUIRE_STAFF_MFA === "true") {
      throw new AppError("FORBIDDEN", { message: "An authenticator is required for staff accounts. Add a new one before removing this one." });
    }
    const { factorId } = parseInput(z.object({ factorId: z.uuid() }), formObject(formData, ["factorId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    // Supabase requires an AAL2 session to remove a verified factor.
    if (error) throw new AppError("FORBIDDEN", { message: "Verify your current code first, then remove the authenticator." });
    revalidatePath("/dashboard/security");
    return null;
  });
}
