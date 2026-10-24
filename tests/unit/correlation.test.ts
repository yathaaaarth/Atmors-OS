import { describe, expect, it } from "vitest";

import { resolveCorrelationId } from "@/server/correlation";

describe("resolveCorrelationId", () => {
  it("accepts well-formed inbound ids", () => {
    expect(resolveCorrelationId("req-12345678")).toBe("req-12345678");
  });

  it("replaces missing or malformed ids", () => {
    for (const inbound of [null, "", "short", "has spaces in it", "<script>alert(1)</script>", "x".repeat(200)]) {
      const id = resolveCorrelationId(inbound);
      expect(id).not.toBe(inbound);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
