import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";

import { CORRELATION_HEADER, resolveCorrelationId } from "@/server/correlation";
import { AppError, fromZodError, toAppError, toErrorEnvelope } from "@/server/errors";
import { logger } from "@/server/logger";

export type RouteContext<P = Record<string, string>> = {
  request: NextRequest;
  params: P;
  correlationId: string;
};

/**
 * Wrap a route handler with correlation IDs and the stable error envelope.
 * Authorization still happens inside each handler, close to the data.
 */
export function handleRoute<P = Record<string, string>>(
  handler: (ctx: RouteContext<P>) => Promise<Response | unknown>,
) {
  return async (request: NextRequest, segment: { params: Promise<P> }) => {
    const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_HEADER));
    try {
      const params = await segment.params;
      const result = await handler({ request, params, correlationId });
      const response = result instanceof Response ? result : NextResponse.json({ data: result });
      response.headers.set(CORRELATION_HEADER, correlationId);
      return response;
    } catch (error) {
      const appError = toAppError(error);
      logger[appError.status >= 500 ? "error" : "warn"]("route.error", {
        correlation_id: correlationId,
        method: request.method,
        path: request.nextUrl.pathname,
        code: appError.code,
        detail: appError.detail,
        cause: appError.cause,
      });
      const { status, body } = toErrorEnvelope(appError, correlationId);
      return NextResponse.json(body, { status, headers: { [CORRELATION_HEADER]: correlationId } });
    }
  };
}

/** Parse a JSON body with a Zod schema; server validation is authoritative. */
export async function parseJsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", { message: "Request body must be valid JSON." });
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

/**
 * CSRF guard for cookie-authenticated, state-changing routes (server actions
 * have this built in; route handlers do not). Browsers always send Origin on
 * cross-site POSTs, so a missing or foreign Origin is refused.
 */
export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    throw new AppError("FORBIDDEN", { detail: `cross-origin request from ${origin ?? "unknown"}` });
  }
}
