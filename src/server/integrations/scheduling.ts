import "server-only";

import {
  bookingOptionsSchema,
  bookingResultSchema,
  type BookingOptions,
  type BookingResult,
  type MeetingPurpose,
} from "@/modules/scheduling/schema";
import { AppError, fromPostgrestError } from "@/server/errors";
import { logger } from "@/server/logger";
import { createSupabaseServerClient } from "@/server/supabase/server";

/** Who is booking: an invitation-token holder, or a signed-in client. */
export type BookingScope = { kind: "token"; tokenHash: string } | { kind: "client"; prospectId: string | null };

export type BookInput = {
  purpose: MeetingPurpose;
  startAt: string;
  timeZone: string;
  note?: string;
  idempotencyKey: string;
  correlationId: string;
};

export type CallbackInput = {
  purpose: MeetingPurpose;
  message?: string;
  idempotencyKey: string;
  correlationId: string;
};

/**
 * Scheduling adapter (PRD §10). The internal provider is a shared booking
 * layer over the canonical meetings table, where Postgres enforces conflict
 * prevention. An external scheduler would implement the same interface and
 * reconcile its callbacks into that table.
 */
export interface SchedulingProvider {
  readonly id: string;
  options(scope: BookingScope, purpose: MeetingPurpose, from: Date, to: Date): Promise<BookingOptions>;
  book(scope: BookingScope, input: BookInput): Promise<BookingResult>;
}

function unavailable(cause: unknown): never {
  throw new AppError("PROVIDER_UNAVAILABLE", { detail: "scheduling provider failed", cause });
}

const internalProvider: SchedulingProvider = {
  id: "internal",

  async options(scope, purpose, from, to) {
    const supabase = await createSupabaseServerClient();
    const { data, error } =
      scope.kind === "token"
        ? await supabase.rpc("booking_options_with_token", {
            p_token_hash: scope.tokenHash,
            p_purpose: purpose,
            p_from: from.toISOString(),
            p_to: to.toISOString(),
          })
        : await supabase.rpc("client_booking_options", {
            p_prospect_id: scope.prospectId as string,
            p_purpose: purpose,
            p_from: from.toISOString(),
            p_to: to.toISOString(),
          });
    if (error) {
      const appError = fromPostgrestError(error);
      if (appError.code === "INTERNAL_ERROR") unavailable(appError);
      throw appError;
    }
    return bookingOptionsSchema.parse(data);
  },

  async book(scope, input) {
    const supabase = await createSupabaseServerClient();
    const common = {
      p_purpose: input.purpose,
      p_start: input.startAt,
      p_timezone: input.timeZone,
      p_note: input.note,
      p_idempotency_key: input.idempotencyKey,
      p_correlation_id: input.correlationId,
    };
    const { data, error } =
      scope.kind === "token"
        ? await supabase.rpc("book_meeting_with_token", { p_token_hash: scope.tokenHash, ...common })
        : await supabase.rpc("client_book_meeting", { p_prospect_id: scope.prospectId as string, ...common });
    if (error) {
      const appError = fromPostgrestError(error);
      if (appError.code === "INTERNAL_ERROR") unavailable(appError);
      throw appError;
    }
    return bookingResultSchema.parse(data);
  },
};

/** Simulates an outage (SCHEDULING_PROVIDER=disabled) so the fallback path can be exercised. */
const disabledProvider: SchedulingProvider = {
  id: "disabled",
  options: async () => unavailable("scheduling disabled by configuration"),
  book: async () => unavailable("scheduling disabled by configuration"),
};

export function schedulingProvider(): SchedulingProvider {
  return process.env.SCHEDULING_PROVIDER === "disabled" ? disabledProvider : internalProvider;
}

/**
 * AT-011: a callback request never depends on the scheduler being up. It is
 * written straight to the database as an internal follow-up task.
 */
export async function requestCallback(scope: BookingScope, input: CallbackInput): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const common = {
    p_purpose: input.purpose,
    p_message: input.message,
    p_idempotency_key: input.idempotencyKey,
    p_correlation_id: input.correlationId,
  };
  const { error } =
    scope.kind === "token"
      ? await supabase.rpc("request_callback_with_token", { p_token_hash: scope.tokenHash, ...common })
      : await supabase.rpc("client_request_callback", { p_prospect_id: scope.prospectId as string, ...common });
  if (error) {
    logger.error("scheduling.callback_failed", { correlation_id: input.correlationId, code: error.code });
    throw fromPostgrestError(error);
  }
}
