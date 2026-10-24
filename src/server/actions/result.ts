import "server-only";

import { headers } from "next/headers";

import { CORRELATION_HEADER, resolveCorrelationId } from "@/server/correlation";
import { toAppError, toErrorEnvelope, type ErrorEnvelope } from "@/server/errors";
import { logger } from "@/server/logger";

export type ActionResult<T> = { ok: true; data: T } | ({ ok: false } & ErrorEnvelope);

/**
 * Run a server action body with a correlation ID and convert failures into the
 * stable error envelope. The body must authorize itself; never trust the client.
 */
export async function runAction<T>(
  name: string,
  body: (correlationId: string) => Promise<T>,
): Promise<ActionResult<T>> {
  const correlationId = resolveCorrelationId((await headers()).get(CORRELATION_HEADER));
  try {
    return { ok: true, data: await body(correlationId) };
  } catch (error) {
    const appError = toAppError(error);
    logger[appError.status >= 500 ? "error" : "warn"]("action.error", {
      action: name,
      correlation_id: correlationId,
      code: appError.code,
      detail: appError.detail,
      cause: appError.cause,
    });
    return { ok: false, ...toErrorEnvelope(appError, correlationId).body };
  }
}
