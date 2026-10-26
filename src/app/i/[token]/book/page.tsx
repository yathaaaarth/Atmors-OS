import type { Metadata } from "next";
import Link from "next/link";

import { BookingPanel, CallbackRequest, MeetingSummary } from "@/components/booking/booking-panel";
import { PublicShell } from "@/components/public-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { newIdempotencyKey } from "@/lib/ids";
import { windowFromNow } from "@/lib/time";
import { hashInvitationToken, isPlausibleInvitationToken } from "@/modules/crm/invitation-token";
import { PURPOSE_LABELS, type BookingOptions } from "@/modules/scheduling/schema";
import { AppError } from "@/server/errors";
import { schedulingProvider } from "@/server/integrations/scheduling";
import { logger } from "@/server/logger";

import { bookWithToken, callbackWithToken } from "./actions";

export const metadata: Metadata = { title: "Book a call", referrer: "no-referrer" };

async function loadOptions(token: string): Promise<BookingOptions | "unavailable"> {
  if (!isPlausibleInvitationToken(token)) return { state: "invalid" };
  const { from, to } = windowFromNow(14);
  try {
    return await schedulingProvider().options({ kind: "token", tokenHash: hashInvitationToken(token) }, "commercial", from, to);
  } catch (error) {
    if (error instanceof AppError && error.code === "PROVIDER_UNAVAILABLE") {
      logger.warn("booking.options_unavailable", { detail: error.detail });
      return "unavailable";
    }
    throw error;
  }
}

export default async function TokenBookingPage(props: PageProps<"/i/[token]/book">) {
  const { token } = await props.params;
  const options = await loadOptions(token);
  const back = (
    <Link href={`/i/${token}`} className="text-sm text-muted-foreground underline underline-offset-4">
      ← Back to your proposal
    </Link>
  );

  if (options !== "unavailable" && options.state === "invalid") {
    return (
      <PublicShell>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="font-heading text-xl font-semibold">This link can&apos;t be used to book</h1>
            </CardTitle>
            <CardDescription>It may have expired or been replaced. Open the latest link from Atmors, or ask for a new one.</CardDescription>
          </CardHeader>
          <CardContent>{back}</CardContent>
        </Card>
      </PublicShell>
    );
  }

  const hidden = { token };
  const slots = options === "unavailable" ? [] : options.slots;
  const upcoming = options === "unavailable" ? [] : options.upcoming;

  return (
    <PublicShell>
      {back}
      <section className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{PURPOSE_LABELS.commercial}</h1>
        <p className="text-sm text-muted-foreground">
          A short call with your Atmors contact about the proposal, scope or pricing. Optional: you can accept without one.
        </p>
      </section>

      {upcoming.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Already booked</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {upcoming.map((meeting) => (
                <li key={meeting.id}>
                  <MeetingSummary meeting={meeting} timeZone={meeting.timezone} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Choose a time</CardTitle>
        </CardHeader>
        <CardContent>
          {slots.length > 0 ? (
            <BookingPanel slots={slots} purpose="commercial" bookAction={bookWithToken} hiddenFields={hidden} idempotencyKey={newIdempotencyKey()} />
          ) : (
            <p className="text-sm">
              {options === "unavailable"
                ? "Booking is temporarily unavailable."
                : "There are no open times in the next two weeks."}{" "}
              Ask for a call below and we&apos;ll arrange one.
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
            action={callbackWithToken}
            hiddenFields={hidden}
            purpose="commercial"
            idempotencyKey={newIdempotencyKey()}
            intro="Tell us what suits you and your Atmors contact will get in touch."
          />
        </CardContent>
      </Card>
    </PublicShell>
  );
}
