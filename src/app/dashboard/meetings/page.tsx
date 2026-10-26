import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { daysAgoIso, isPast } from "@/lib/time";
import { COMMON_TIMEZONES, MEETING_PURPOSES, PURPOSE_LABELS, WEEKDAYS, formatMeetingTime } from "@/modules/scheduling/schema";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";
import { saveBookingHost, updateMeeting } from "./actions";

export const metadata: Metadata = { title: "Meetings" };

type Window = { day: number; start: string; end: string };

const DEFAULT_HOURS: Window[] = [1, 2, 3, 4, 5].map((day) => ({ day, start: "10:00", end: "17:00" }));

function HostForm({
  userId,
  name,
  host,
  canRoute,
}: {
  userId: string;
  name: string;
  host: { purposes: string[]; timezone: string; weekly_hours: unknown; slot_minutes: number; min_notice_hours: number; horizon_days: number; active: boolean } | null;
  canRoute: boolean;
}) {
  const hours = (host?.weekly_hours as Window[] | undefined) ?? DEFAULT_HOURS;
  const purposes = host?.purposes ?? ["commercial"];
  return (
    <ActionForm action={saveBookingHost} submitLabel={host ? "Save availability" : "Make bookable"} variant="outline" successMessage="Saved.">
      <input type="hidden" name="userId" value={userId} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{name}: takes these calls</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {MEETING_PURPOSES.map((purpose) =>
            canRoute ? (
              <label key={purpose} className="flex items-center gap-2">
                <input type="checkbox" name="purpose" value={purpose} defaultChecked={purposes.includes(purpose)} />
                {PURPOSE_LABELS[purpose]}
              </label>
            ) : purposes.includes(purpose) ? (
              <span key={purpose}>
                <input type="hidden" name="purpose" value={purpose} />
                {PURPOSE_LABELS[purpose]}
              </span>
            ) : null,
          )}
        </div>
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {WEEKDAYS.map((label, index) => {
          const window = hours.find((entry) => entry.day === index + 1);
          return (
            <div key={label} className="space-y-1">
              <span className="text-xs font-medium">{label}</span>
              <div className="flex items-center gap-1">
                <Input aria-label={`${label} start`} name={`day${index + 1}_start`} type="time" defaultValue={window?.start} className="w-28" />
                <span aria-hidden>–</span>
                <Input aria-label={`${label} end`} name={`day${index + 1}_end`} type="time" defaultValue={window?.end} className="w-28" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`tz-${userId}`}>Timezone</Label>
          <select id={`tz-${userId}`} name="timezone" defaultValue={host?.timezone ?? "Asia/Kolkata"} className="h-9 rounded-md border bg-background px-2 text-sm">
            {COMMON_TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`slot-${userId}`}>Call length</Label>
          <select id={`slot-${userId}`} name="slotMinutes" defaultValue={host?.slot_minutes ?? 30} className="h-9 rounded-md border bg-background px-2 text-sm">
            {[15, 30, 45, 60].map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`notice-${userId}`}>Notice (hours)</Label>
          <Input id={`notice-${userId}`} name="minNoticeHours" type="number" min={0} max={168} defaultValue={host?.min_notice_hours ?? 12} className="w-24" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`horizon-${userId}`}>Book ahead (days)</Label>
          <Input id={`horizon-${userId}`} name="horizonDays" type="number" min={1} max={60} defaultValue={host?.horizon_days ?? 21} className="w-24" />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={host?.active ?? true} /> Accepting bookings
        </label>
      </div>
    </ActionForm>
  );
}

export default async function MeetingsPage() {
  const access = await memberPageAccess("/dashboard/meetings");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  const supabase = await createSupabaseServerClient();
  const canRoute = can(context, "scheduling.configure");

  // RLS: all meetings with meetings.read_all; otherwise the ones you host or whose prospect you can read.
  const [meetings, hosts, members] = await Promise.all([
    supabase
      .from("meetings")
      .select("id, purpose, status, start_at, end_at, timezone, host_user_id, attendee_note, prospects(id, name, company)")
      .eq("organization_id", context.organizationId)
      .gte("end_at", daysAgoIso(7))
      .order("start_at")
      .limit(100),
    supabase.from("booking_hosts").select("*").eq("organization_id", context.organizationId),
    canRoute
      ? supabase.from("organization_memberships").select("user_id, profiles(display_name, email)").eq("organization_id", context.organizationId).eq("status", "active")
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [meetings, hosts, members]) {
    if (result.error) throw fromPostgrestError(result.error);
  }
  const hostByUser = new Map((hosts.data ?? []).map((host) => [host.user_id, host]));
  const ownHost = hostByUser.get(context.userId) ?? null;
  const canManageAll = can(context, "meetings.manage");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Meetings</h1>
        <p className="text-sm text-muted-foreground">
          One shared booking system: clients book from their invitation link or portal, routed to the right host. Times show
          in India time; the client&apos;s own timezone is listed with each booking.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming and recent</CardTitle>
        </CardHeader>
        <CardContent>
          {(meetings.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No meetings in this window.</p>
          ) : (
            <ul className="divide-y text-sm">
              {(meetings.data ?? []).map((meeting) => {
                const active = meeting.status === "booked" || meeting.status === "rescheduled";
                const mayManage = canManageAll || meeting.host_user_id === context.userId;
                const started = isPast(meeting.start_at);
                return (
                  <li key={meeting.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <Link href={`/dashboard/prospects/${meeting.prospects?.id}`} className="font-medium hover:underline">
                          {meeting.prospects?.company ?? meeting.prospects?.name}
                        </Link>{" "}
                        · {PURPOSE_LABELS[meeting.purpose]}
                        <span className="block text-muted-foreground">
                          {formatMeetingTime(meeting.start_at, meeting.end_at, "Asia/Kolkata")}
                          {meeting.timezone !== "Asia/Kolkata" ? ` · client: ${formatMeetingTime(meeting.start_at, meeting.end_at, meeting.timezone)}` : ""}
                        </span>
                        {meeting.attendee_note ? <span className="block">“{meeting.attendee_note}”</span> : null}
                      </span>
                      <StatusBadge status={meeting.status} />
                    </div>
                    {active && mayManage ? (
                      <div className="flex flex-wrap gap-3">
                        {started ? (
                          <>
                            <ActionForm action={updateMeeting} submitLabel="Mark completed" variant="outline">
                              <input type="hidden" name="meetingId" value={meeting.id} />
                              <input type="hidden" name="action" value="complete" />
                            </ActionForm>
                            <ActionForm action={updateMeeting} submitLabel="Mark no-show" variant="outline">
                              <input type="hidden" name="meetingId" value={meeting.id} />
                              <input type="hidden" name="action" value="no_show" />
                            </ActionForm>
                          </>
                        ) : (
                          <details>
                            <summary className="cursor-pointer text-sm">Cancel</summary>
                            <ActionForm action={updateMeeting} submitLabel="Cancel booking" variant="destructive" className="mt-2">
                              <input type="hidden" name="meetingId" value={meeting.id} />
                              <input type="hidden" name="action" value="cancel" />
                              <Input name="reason" placeholder="Reason (audited)" required aria-label="Cancellation reason" />
                            </ActionForm>
                          </details>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{canRoute ? "Hosts and routing" : "Your availability"}</CardTitle>
          <CardDescription>
            Commercial calls go to the prospect&apos;s owner when they take commercial calls, otherwise to the commercial pool.
            Leave a day blank to be unavailable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          {canRoute ? (
            (members.data ?? []).map((member) => (
              <HostForm
                key={member.user_id}
                userId={member.user_id}
                name={member.profiles?.display_name || member.profiles?.email || "Member"}
                host={hostByUser.get(member.user_id) ?? null}
                canRoute
              />
            ))
          ) : ownHost ? (
            <HostForm userId={context.userId} name="You" host={ownHost} canRoute={false} />
          ) : (
            <p className="text-sm text-muted-foreground">You are not set up as a booking host. Ask the Founder to add you.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
