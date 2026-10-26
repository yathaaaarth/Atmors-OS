"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { BookingResult } from "@/modules/scheduling/schema";
import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireSessionUser } from "@/server/auth/session";
import { bookFromForm, callbackFromForm } from "@/server/booking";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

// The database resolves (and checks) which prospect this client acts for.
const CLIENT_SCOPE = { kind: "client" as const, prospectId: null };

export async function bookAsClient(_: unknown, formData: FormData): Promise<ActionResult<BookingResult>> {
  return runAction("meeting.book_as_client", async (correlationId) => {
    await requireSessionUser();
    const result = await bookFromForm(CLIENT_SCOPE, formData, correlationId);
    revalidatePath("/portal");
    return result;
  });
}

export async function callbackAsClient(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("meeting.callback_as_client", async (correlationId) => {
    await requireSessionUser();
    return callbackFromForm(CLIENT_SCOPE, formData, correlationId);
  });
}

const cancelSchema = z.object({ meetingId: z.uuid(), reason: z.string().trim().max(2000).optional() });

export async function cancelMeeting(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("meeting.client_cancel", async (correlationId) => {
    await requireSessionUser();
    const values = parseInput(cancelSchema, formObject(formData, ["meetingId", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("client_change_meeting", {
      p_meeting_id: values.meetingId,
      p_action: "cancel",
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/portal");
    return null;
  });
}
