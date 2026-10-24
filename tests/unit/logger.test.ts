import { describe, expect, it } from "vitest";

import { redact } from "@/server/logger";

describe("redact", () => {
  it("redacts sensitive keys at any depth", () => {
    expect(
      redact({
        correlation_id: "abc",
        invitation_token: "raw-token",
        nested: { Authorization: "Bearer x", items: [{ password: "p" }] },
      }),
    ).toEqual({
      correlation_id: "abc",
      invitation_token: "[redacted]",
      nested: { Authorization: "[redacted]", items: [{ password: "[redacted]" }] },
    });
  });

  it("reduces errors to name and message", () => {
    expect(redact(new TypeError("bad"))).toEqual({ name: "TypeError", message: "bad" });
  });
});
