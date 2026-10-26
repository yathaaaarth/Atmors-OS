"use server";

import type { BookingResult } from "@/modules/scheduling/schema";
import { hashInvitationToken, isPlausibleInvitationToken } from "@/modules/crm/invitation-token";
import { runAction, type ActionResult } from "@/server/actions/result";
import { bookFromForm, callbackFromForm } from "@/server/booking";
import { AppError } from "@/server/errors";

function tokenScope(formData: FormData) {
  const token = formData.get("token");
  if (typeof token !== "string" || !isPlausibleInvitationToken(token)) {
    throw new AppError("INVITATION_EXPIRED", { message: "This link is not valid." });
  }
  return { kind: "token" as const, tokenHash: hashInvitationToken(token) };
}

/** Booking a call is not a sensitive action, so the invitation token is enough. */
export async function bookWithToken(_: unknown, formData: FormData): Promise<ActionResult<BookingResult>> {
  return runAction("meeting.book_with_token", (correlationId) => bookFromForm(tokenScope(formData), formData, correlationId));
}

export async function callbackWithToken(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("meeting.callback_with_token", async (correlationId) => {
    // Unknown tokens get the same success response (no probing).
    if (!isPlausibleInvitationToken(String(formData.get("token") ?? ""))) return null;
    return callbackFromForm(tokenScope(formData), formData, correlationId);
  });
}
