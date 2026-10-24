import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "@/lib/safe-redirect";

describe("safeRedirectPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeRedirectPath("/dashboard/team?tab=1#x")).toBe("/dashboard/team?tab=1#x");
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "dashboard",
    "",
    null,
    undefined,
  ])("falls back for %s", (input) => {
    expect(safeRedirectPath(input)).toBe("/dashboard");
  });
});
