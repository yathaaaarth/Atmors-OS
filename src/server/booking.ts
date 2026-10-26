import "server-only";

import { z } from "zod";

import { MEETING_PURPOSES, isValidTimeZone, type BookingResult } from "@/modules/scheduling/schema";
import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { AppError } from "@/server/errors";
import { requestCallback, schedulingProvider, type BookingScope } from "@/server/integrations/scheduling";

const bookSchema = z.object({
  purpose: z.enum(MEETING_PURPOSES),
  startAt: z.iso.datetime({ offset: true, error: "Choose a time." }),
  timeZone: z.string().refine(isValidTimeZone, "Choose a valid timezone."),
  note: z.string().trim().max(2000).optional(),
  idempotencyKey: z.uuid(),
});

const callbackSchema = z.object({
  purpose: z.enum(MEETING_PURPOSES),
  message: z.string().trim().max(2000).optional(),
  idempotencyKey: z.uuid(),
});

/** Shared body of the token and portal booking actions. */
export async function bookFromForm(scope: BookingScope, formData: FormData, correlationId: string): Promise<BookingResult> {
  const values = parseInput(bookSchema, formObject(formData, ["purpose", "startAt", "timeZone", "note", "idempotencyKey"]));
  const result = await schedulingProvider().book(scope, {
    purpose: values.purpose,
    startAt: values.startAt,
    timeZone: values.timeZone,
    note: values.note,
    idempotencyKey: values.idempotencyKey,
    correlationId,
  });
  if (result.status === "invalid") throw new AppError("INVITATION_EXPIRED");
  return result;
}

export async function callbackFromForm(scope: BookingScope, formData: FormData, correlationId: string): Promise<null> {
  const values = parseInput(callbackSchema, formObject(formData, ["purpose", "message", "idempotencyKey"]));
  await requestCallback(scope, { ...values, correlationId });
  return null;
}
