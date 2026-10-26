"use client";

import { useActionState, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  COMMON_TIMEZONES,
  formatInZone,
  formatMeetingTime,
  groupSlotsByDay,
  type BookingResult,
  type ClientMeeting,
  type MeetingPurpose,
  type Slot,
} from "@/modules/scheduling/schema";

type ErrorState = { ok: false; error: { message: string; correlation_id: string } };
export type BookingState = { ok: true; data: BookingResult } | ErrorState | null;
export type BookingAction = (state: BookingState, formData: FormData) => Promise<BookingState>;
export type CallbackState = { ok: true; data: unknown } | ErrorState | null;
export type CallbackAction = (state: CallbackState, formData: FormData) => Promise<CallbackState>;

const noSubscription = () => () => {};

/** The visitor's timezone after hydration; India time during server render. */
function useBrowserTimeZone(): string {
  return useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
    () => "Asia/Kolkata",
  );
}

function HiddenFields({ fields }: { fields: Record<string, string> }) {
  return Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />);
}

export function MeetingSummary({ meeting, timeZone }: { meeting: ClientMeeting; timeZone: string }) {
  return (
    <span>
      {formatMeetingTime(meeting.start_at, meeting.end_at, timeZone)}
      {meeting.host_name ? ` with ${meeting.host_name}` : ""}
    </span>
  );
}

/**
 * Shared booking experience for invitation holders and signed-in clients
 * (PRD §5.4). Times are shown in the visitor's timezone and sent as UTC
 * instants; the chosen zone is stored for display. If the slot is taken
 * meanwhile, the server answers with alternatives (AT-010).
 */
export function BookingPanel({
  slots,
  purpose,
  bookAction,
  hiddenFields,
  idempotencyKey,
}: {
  slots: Slot[];
  purpose: MeetingPurpose;
  bookAction: BookingAction;
  hiddenFields: Record<string, string>;
  idempotencyKey: string;
}) {
  const browserZone = useBrowserTimeZone();
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  const timeZone = zoneChoice ?? browserZone;
  const [state, formAction, pending] = useActionState(bookAction, null);

  const result = state?.ok ? state.data : null;
  if (result?.status === "booked") {
    return (
      <div role="status" className="space-y-1 rounded-lg border border-brand/40 p-4 text-sm">
        <p className="font-medium">You&apos;re booked{result.replayed ? " (already confirmed)" : ""}</p>
        <p>
          <MeetingSummary meeting={result.meeting} timeZone={timeZone} />
        </p>
        <p className="text-muted-foreground">Your place in the proposal is saved. You can return to it any time.</p>
      </div>
    );
  }

  const alternatives = result?.status === "slot_unavailable" ? result.alternatives : null;
  const days = groupSlotsByDay(alternatives ?? slots, timeZone);
  const zones = COMMON_TIMEZONES.includes(timeZone as (typeof COMMON_TIMEZONES)[number]) ? [...COMMON_TIMEZONES] : [timeZone, ...COMMON_TIMEZONES];

  return (
    <form action={formAction} className="space-y-4">
      <HiddenFields fields={{ ...hiddenFields, purpose, idempotencyKey, timeZone }} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="booking-zone">Show times in</Label>
          <select
            id="booking-zone"
            value={timeZone}
            onChange={(event) => setZoneChoice(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
      </div>

      {alternatives ? (
        <p role="alert" className="text-sm text-destructive">
          That time was just taken. {alternatives.length > 0 ? "Here are the nearest open times:" : "There are no nearby open times."}
        </p>
      ) : null}

      {days.length > 0 ? (
        <div className="space-y-2">
          {days.map((day, index) => (
            <details key={day.key} open={index === 0} className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {day.label} <span className="text-muted-foreground">({day.slots.length} open)</span>
              </summary>
              <fieldset className="mt-3 flex flex-wrap gap-2">
                <legend className="sr-only">Times on {day.label}</legend>
                {day.slots.map((slot) => (
                  <label
                    key={slot.start_at}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                  >
                    <input type="radio" name="startAt" value={slot.start_at} required className="sr-only" />
                    {formatInZone(slot.start_at, timeZone, { hour: "numeric", minute: "2-digit" })}
                  </label>
                ))}
              </fieldset>
            </details>
          ))}
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="booking-note">Anything we should know? (optional)</Label>
        <Textarea id="booking-note" name="note" rows={2} maxLength={2000} />
      </div>
      <Button type="submit" disabled={pending || days.length === 0}>
        {pending ? "Booking…" : "Book this time"}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error.message} <span className="text-xs text-muted-foreground">(ref {state.error.correlation_id.slice(0, 8)})</span>
        </p>
      ) : null}
    </form>
  );
}

/** AT-011 fallback: always available, even when no slots load. */
export function CallbackRequest({
  action,
  hiddenFields,
  purpose,
  idempotencyKey,
  intro,
}: {
  action: CallbackAction;
  hiddenFields: Record<string, string>;
  purpose: MeetingPurpose;
  idempotencyKey: string;
  intro: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  if (state?.ok) {
    return (
      <p role="status" className="rounded-lg border p-4 text-sm">
        Thanks. Your Atmors contact will call or email you to find a time.
      </p>
    );
  }
  return (
    <form action={formAction} className="space-y-3">
      <HiddenFields fields={{ ...hiddenFields, purpose, idempotencyKey }} />
      <p className="text-sm text-muted-foreground">{intro}</p>
      <div className="space-y-1">
        <Label htmlFor="callback-message">When suits you, and how should we reach you?</Label>
        <Textarea id="callback-message" name="message" rows={3} maxLength={2000} />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Sending…" : "Ask Atmors to call me"}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
