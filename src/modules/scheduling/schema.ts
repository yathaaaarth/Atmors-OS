import { z } from "zod";

export const MEETING_PURPOSES = ["commercial", "onboarding", "delivery"] as const;
export type MeetingPurpose = (typeof MEETING_PURPOSES)[number];

export const PURPOSE_LABELS: Record<MeetingPurpose, string> = {
  commercial: "Proposal and pricing call",
  onboarding: "Onboarding call",
  delivery: "Delivery check-in",
};

export const slotSchema = z.object({ start_at: z.string(), end_at: z.string() });
export type Slot = z.infer<typeof slotSchema>;

export const clientMeetingSchema = z.object({
  id: z.uuid(),
  purpose: z.enum(MEETING_PURPOSES),
  status: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  timezone: z.string(),
  host_name: z.string().nullable(),
  can_change: z.boolean(),
});
export type ClientMeeting = z.infer<typeof clientMeetingSchema>;

export const bookingOptionsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("invalid") }),
  z.object({ state: z.literal("valid"), slots: z.array(slotSchema), upcoming: z.array(clientMeetingSchema) }),
]);
export type BookingOptions = z.infer<typeof bookingOptionsSchema>;

export const bookingResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("booked"), replayed: z.boolean().optional(), meeting: clientMeetingSchema }),
  z.object({ status: z.literal("slot_unavailable"), alternatives: z.array(slotSchema) }),
  z.object({ status: z.literal("cancelled"), meeting: clientMeetingSchema }),
  z.object({ status: z.literal("invalid") }),
]);
export type BookingResult = z.infer<typeof bookingResultSchema>;

/** Weekly availability window in the host's timezone (Monday = 1). */
export const weeklyWindowSchema = z
  .object({
    day: z.number().int().min(1).max(7),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .refine((window) => window.end > window.start, { message: "End must be after start." });

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Commonly used zones; the visitor's own zone is added when it is not listed. */
export const COMMON_TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
] as const;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function formatInZone(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone, ...options }).format(new Date(iso));
}

/** "Tue, 27 Oct, 10:00 am – 10:30 am (Asia/Kolkata)" */
export function formatMeetingTime(startIso: string, endIso: string, timeZone: string): string {
  const day = formatInZone(startIso, timeZone, { weekday: "short", day: "numeric", month: "short" });
  const start = formatInZone(startIso, timeZone, { hour: "numeric", minute: "2-digit" });
  const end = formatInZone(endIso, timeZone, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${start} – ${end} (${timeZone})`;
}

/** Group slots by calendar day in the viewer's timezone, preserving order. */
export function groupSlotsByDay(slots: Slot[], timeZone: string): { key: string; label: string; slots: Slot[] }[] {
  const groups = new Map<string, { key: string; label: string; slots: Slot[] }>();
  const keyFormat = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const slot of slots) {
    const key = keyFormat.format(new Date(slot.start_at));
    let group = groups.get(key);
    if (!group) {
      group = { key, label: formatInZone(slot.start_at, timeZone, { weekday: "long", day: "numeric", month: "long" }), slots: [] };
      groups.set(key, group);
    }
    group.slots.push(slot);
  }
  return [...groups.values()];
}
