import type { ZodError } from "zod";

/**
 * Stable error codes shared by API routes, server actions and database RPCs
 * (RPCs raise these codes as the exception message). PRD §9.
 */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "INVALID_STATE_TRANSITION",
  "VERSION_STALE",
  "CONFLICT",
  "INVITATION_EXPIRED",
  "INVITATION_REVOKED",
  "PAYMENT_PENDING",
  "PAYMENT_MISMATCH",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_DEFINITIONS: Record<ErrorCode, { status: number; message: string; retryable: boolean }> = {
  UNAUTHENTICATED: { status: 401, message: "Please sign in to continue.", retryable: false },
  FORBIDDEN: { status: 403, message: "You don't have permission to do that.", retryable: false },
  NOT_FOUND: { status: 404, message: "We couldn't find that.", retryable: false },
  VALIDATION_FAILED: { status: 422, message: "Some details need attention.", retryable: false },
  INVALID_STATE_TRANSITION: {
    status: 409,
    message: "That action isn't available in the current state.",
    retryable: false,
  },
  VERSION_STALE: {
    status: 409,
    message: "This record changed since you opened it. Refresh and try again.",
    retryable: false,
  },
  CONFLICT: { status: 409, message: "That change conflicts with the current data.", retryable: false },
  INVITATION_EXPIRED: { status: 410, message: "This invitation link has expired.", retryable: false },
  INVITATION_REVOKED: { status: 410, message: "This invitation link is no longer valid.", retryable: false },
  PAYMENT_PENDING: { status: 409, message: "Your payment is still being confirmed.", retryable: true },
  PAYMENT_MISMATCH: {
    status: 409,
    message: "We couldn't match this payment. Our team has been notified.",
    retryable: false,
  },
  PROVIDER_UNAVAILABLE: {
    status: 503,
    message: "A connected service is temporarily unavailable. Please try again shortly.",
    retryable: true,
  },
  RATE_LIMITED: { status: 429, message: "Too many requests. Please wait a moment.", retryable: true },
  INTERNAL_ERROR: { status: 500, message: "Something went wrong on our side.", retryable: true },
};

export type FieldErrors = Record<string, string[]>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors?: FieldErrors;
  /** Internal-only detail; logged, never returned to clients. */
  readonly detail?: string;

  constructor(
    code: ErrorCode,
    options: { message?: string; fieldErrors?: FieldErrors; detail?: string; cause?: unknown } = {},
  ) {
    const definition = ERROR_DEFINITIONS[code];
    super(options.message ?? definition.message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = definition.status;
    this.retryable = definition.retryable;
    this.fieldErrors = options.fieldErrors;
    this.detail = options.detail;
  }
}

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    field_errors?: FieldErrors;
    correlation_id: string;
    retryable: boolean;
  };
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Coerce anything thrown into an AppError without leaking internals. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL_ERROR", { cause: error });
}

export function toErrorEnvelope(error: unknown, correlationId: string): { status: number; body: ErrorEnvelope } {
  const appError = toAppError(error);
  return {
    status: appError.status,
    body: {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.fieldErrors ? { field_errors: appError.fieldErrors } : {}),
        correlation_id: correlationId,
        retryable: appError.retryable,
      },
    },
  };
}

export function fromZodError(error: ZodError): AppError {
  const fieldErrors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return new AppError("VALIDATION_FAILED", { fieldErrors });
}

type PostgrestLikeError = { code?: string; message?: string; details?: string | null };

/**
 * Map a PostgREST/RPC error to an AppError. RPCs raise stable codes as the
 * message; well-known Postgres codes are mapped as a fallback.
 */
export function fromPostgrestError(error: PostgrestLikeError): AppError {
  const detail = [error.code, error.message, error.details].filter(Boolean).join(" | ");
  if (isErrorCode(error.message)) {
    return new AppError(error.message, { detail });
  }
  switch (error.code) {
    case "42501":
      return new AppError("FORBIDDEN", { detail });
    case "23505":
    case "23514":
      return new AppError("CONFLICT", { detail });
    case "22023":
    case "22P02":
    case "23502":
      return new AppError("VALIDATION_FAILED", { detail });
    case "PGRST116":
      return new AppError("NOT_FOUND", { detail });
    default:
      return new AppError("INTERNAL_ERROR", { detail });
  }
}
