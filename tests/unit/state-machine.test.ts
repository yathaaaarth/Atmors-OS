import { describe, expect, it } from "vitest";

import { prospectStateMachine } from "@/modules/crm/prospect-state";
import { AppError } from "@/server/errors";
import { defineStateMachine } from "@/server/workflows/state-machine";

describe("defineStateMachine", () => {
  it("rejects definitions that target unknown states", () => {
    expect(() =>
      defineStateMachine<"a" | "b">({
        name: "broken",
        initial: "a",
        transitions: { a: ["c" as "b"], b: [] },
      }),
    ).toThrow(/unknown state/);
  });

  it("throws INVALID_STATE_TRANSITION for illegal transitions", () => {
    try {
      prospectStateMachine.assertTransition("new", "converted");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("INVALID_STATE_TRANSITION");
    }
  });
});

describe("prospect state machine", () => {
  it("follows the canonical path", () => {
    const path = ["new", "contacted", "engaged", "proposal_sent", "converted"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(prospectStateMachine.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("allows returning to negotiation and re-engaging a declined prospect", () => {
    expect(prospectStateMachine.canTransition("proposal_sent", "engaged")).toBe(true);
    expect(prospectStateMachine.canTransition("declined", "contacted")).toBe(true);
  });

  it("treats archived as terminal and never skips straight to converted", () => {
    expect(prospectStateMachine.isTerminal("archived")).toBe(true);
    expect(prospectStateMachine.canTransition("new", "converted")).toBe(false);
    expect(prospectStateMachine.canTransition("engaged", "converted")).toBe(false);
  });
});
