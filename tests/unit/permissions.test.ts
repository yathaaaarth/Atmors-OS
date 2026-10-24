import { describe, expect, it } from "vitest";

import { assertCan, can, toPermissionSet } from "@/server/authorization/permissions";
import { AppError } from "@/server/errors";

describe("permissions", () => {
  const permissions = toPermissionSet([
    { permission_key: "members.read", allowed: true },
    { permission_key: "members.manage", allowed: false },
    { permission_key: "unknown.future_key", allowed: true },
  ]);

  it("only includes allowed, known permission keys", () => {
    expect([...permissions]).toEqual(["members.read"]);
  });

  it("checks membership of the permission set", () => {
    expect(can({ permissions }, "members.read")).toBe(true);
    expect(can({ permissions }, "members.manage")).toBe(false);
  });

  it("assertCan throws FORBIDDEN", () => {
    expect(() => assertCan({ permissions }, "finance.read")).toThrow(AppError);
    try {
      assertCan({ permissions }, "finance.read");
    } catch (error) {
      expect((error as AppError).code).toBe("FORBIDDEN");
    }
  });
});
