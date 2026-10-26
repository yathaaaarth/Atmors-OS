"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { MEETING_PURPOSES, WEEKDAYS, isValidTimeZone, weeklyWindowSchema } from "@/modules/scheduling/schema";
import { formObject, formString } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

const hostSchema = z.object({
  userId: z.uuid(),
  purposes: z.array(z.enum(MEETING_PURPOSES)).min(1, "Choose at least one call type."),
  timezone: z.string().refine(isValidTimeZone, "Choose a valid timezone."),
  weeklyHours: z.array(weeklyWindowSchema).max(21),
  slotMinutes: z.coerce.number().int().refine((value) => [15, 30, 45, 60].includes(value)),
  minNoticeHours: z.coerce.number().int().min(0).max(168),
  horizonDays: z.coerce.number().int().min(1).max(60),
});

/** Weekly hours arrive as day<N>_start / day<N>_end pairs; blank days are unavailable. */
function weeklyHoursFrom(formData: FormData) {
  return WEEKDAYS.flatMap((_, index) => {
    const day = index + 1;
    const start = formString(formData, `day${day}_start`);
    const end = formString(formData, `day${day}_end`);
    return start && end ? [{ day, start, end }] : [];
  });
}

export async function saveBookingHost(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("booking_host.save", async (correlationId) => {
    const context = await requireMemberContext();
    const values = parseInput(hostSchema, {
      ...formObject(formData, ["userId", "timezone", "slotMinutes", "minNoticeHours", "horizonDays"]),
      purposes: formData.getAll("purpose"),
      weeklyHours: weeklyHoursFrom(formData),
    });
    const supabase = await createSupabaseServerClient();
    // The RPC decides who may change routing; hosts may only adjust their own hours.
    const { error } = await supabase.rpc("save_booking_host", {
      p_organization_id: context.organizationId,
      p_user_id: values.userId,
      p_purposes: values.purposes,
      p_timezone: values.timezone,
      p_weekly_hours: values.weeklyHours,
      p_slot_minutes: values.slotMinutes,
      p_min_notice_hours: values.minNoticeHours,
      p_horizon_days: values.horizonDays,
      p_active: formData.get("active") === "on",
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/meetings");
    return null;
  });
}

const meetingSchema = z.object({
  meetingId: z.uuid(),
  action: z.enum(["cancel", "complete", "no_show"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function updateMeeting(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("meeting.update", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(meetingSchema, formObject(formData, ["meetingId", "action", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_meeting", {
      p_meeting_id: values.meetingId,
      p_action: values.action,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/meetings");
    revalidatePath("/dashboard");
    return null;
  });
}
