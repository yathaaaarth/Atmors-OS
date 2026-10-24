import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError, fromPostgrestError, fromZodError, toErrorEnvelope } from "@/server/errors";

describe("error envelope", () => {
  it("returns the stable shape with correlation id and retryable flag", () => {
    const { status, body } = toErrorEnvelope(new AppError("FORBIDDEN"), "corr-12345678");
    expect(status).toBe(403);
    expect(body).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "You don't have permission to do that.",
        correlation_id: "corr-12345678",
        retryable: false,
      },
    });
  });

  it("never leaks details of unexpected errors", () => {
    const leaky = new Error("connection string postgres://user:secret@db");
    const { status, body } = toErrorEnvelope(leaky, "corr-12345678");
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("keeps internal detail off the envelope", () => {
    const error = new AppError("CONFLICT", { detail: "membership 123 last admin" });
    expect(JSON.stringify(toErrorEnvelope(error, "corr-12345678").body)).not.toContain("last admin");
  });

  it("maps zod issues to field errors", () => {
    const result = z.object({ email: z.email(), reason: z.string().min(3) }).safeParse({ email: "x", reason: "" });
    expect(result.success).toBe(false);
    const error = fromZodError(result.error!);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(error.fieldErrors ?? {})).toEqual(["email", "reason"]);
  });
});

describe("fromPostgrestError", () => {
  it("prefers stable codes raised by RPCs", () => {
    expect(fromPostgrestError({ code: "23505", message: "CONFLICT" }).code).toBe("CONFLICT");
    expect(fromPostgrestError({ code: "42501", message: "APPROVAL_REQUIRED" }).code).toBe("APPROVAL_REQUIRED");
    expect(fromPostgrestError({ code: "42501", message: "FORBIDDEN" }).code).toBe("FORBIDDEN");
    expect(fromPostgrestError({ code: "28000", message: "UNAUTHENTICATED" }).code).toBe("UNAUTHENTICATED");
  });

  it("falls back to Postgres error classes", () => {
    expect(fromPostgrestError({ code: "42501", message: "permission denied for table x" }).code).toBe("FORBIDDEN");
    expect(fromPostgrestError({ code: "23505", message: "duplicate key" }).code).toBe("CONFLICT");
    expect(fromPostgrestError({ code: "23514", message: "violates check constraint" }).code).toBe("VALIDATION_FAILED");
    expect(fromPostgrestError({ code: "XX000", message: "boom" }).code).toBe("INTERNAL_ERROR");
  });
});
