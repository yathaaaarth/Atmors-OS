import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BookingPanel, CallbackRequest } from "@/components/booking/booking-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { newIdempotencyKey } from "@/lib/ids";
import { windowFromNow } from "@/lib/time";
import { MEETING_PURPOSES, PURPOSE_LABELS, type MeetingPurpose, type Slot } from "@/modules/scheduling/schema";
import { getSessionUser } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { schedulingProvider } from "@/server/integrations/scheduling";
import { logger } from "@/server/logger";

import { bookAsClient, callbackAsClient } from "./actions";

export const metadata: Metadata = { title: "Book a call" };

const CLIENT_PURPOSES: MeetingPurpose[] = ["commercial", "onboarding"];

export default async function PortalBookPage(props: PageProps<"/portal/book">) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/portal/book");
  const params = await props.searchParams;
  const requested = typeof params.purpose === "string" ? params.purpose : "commercial";
  const purpose: MeetingPurpose = (MEETING_PURPOSES as readonly string[]).includes(requested) && CLIENT_PURPOSES.includes(requested as MeetingPurpose)
    ? (requested as MeetingPurpose)
    : "commercial";

  let slots: Slot[] = [];
  let unavailable = false;
  try {
    const { from, to } = windowFromNow(14);
    const options = await schedulingProvider().options({ kind: "client", prospectId: null }, purpose, from, to);
    if (options.state === "valid") slots = options.slots;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "NOT_FOUND") redirect("/portal");
    if (error.code !== "PROVIDER_UNAVAILABLE") throw error;
    logger.warn("booking.options_unavailable", { detail: error.detail });
    unavailable = true;
  }

  return (
    <div className="space-y-6">
      <Link href="/portal" className="text-sm text-muted-foreground underline underline-offset-4">
        ← Your portal
      </Link>
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Book a call</h1>
        <nav aria-label="Call type" className="flex flex-wrap gap-2 text-sm">
          {CLIENT_PURPOSES.map((value) => (
            <Link
              key={value}
              href={`/portal/book?purpose=${value}`}
              aria-current={value === purpose ? "page" : undefined}
              className={value === purpose ? "rounded-full bg-primary px-3 py-1 text-primary-foreground" : "rounded-full border px-3 py-1"}
            >
              {PURPOSE_LABELS[value]}
            </Link>
          ))}
        </nav>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Choose a time</CardTitle>
        </CardHeader>
        <CardContent>
          {slots.length > 0 ? (
            <BookingPanel slots={slots} purpose={purpose} bookAction={bookAsClient} hiddenFields={{}} idempotencyKey={newIdempotencyKey()} />
          ) : (
            <p className="text-sm">
              {unavailable ? "Booking is temporarily unavailable." : "There are no open times for this call in the next two weeks."} Ask for
              a call below and we&apos;ll arrange one.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">None of these work?</CardTitle>
        </CardHeader>
        <CardContent>
          <CallbackRequest
            action={callbackAsClient}
            hiddenFields={{}}
            purpose={purpose}
            idempotencyKey={newIdempotencyKey()}
            intro="Tell us what suits you and the right person at Atmors will get in touch."
          />
        </CardContent>
      </Card>
    </div>
  );
}
