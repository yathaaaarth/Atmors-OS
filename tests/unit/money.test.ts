import { describe, expect, it } from "vitest";

import {
  computeLine,
  computeTotals,
  formatMoney,
  minorToMajorString,
  parseMajorToMinor,
  scheduleAmounts,
  validateSchedule,
} from "@/modules/proposals/money";

describe("computeLine (must match public.save_proposal_draft)", () => {
  // Vectors captured from the database implementation.
  it("rounds half up on fractional quantities and tax", () => {
    expect(computeLine({ quantity: 2.5, unit_amount_minor: 1_000_001, discount_minor: 0, tax_rate_bps: 1800 })).toEqual({
      gross_minor: 2_500_003,
      net_minor: 2_500_003,
      tax_minor: 450_001,
      total_minor: 2_950_004,
    });
  });

  it("applies discount before tax", () => {
    expect(
      computeLine({ quantity: 1, unit_amount_minor: 5_000_000, discount_minor: 500_000, tax_rate_bps: 1800 }),
    ).toEqual({ gross_minor: 5_000_000, net_minor: 4_500_000, tax_minor: 810_000, total_minor: 5_310_000 });
  });

  it("stays exact beyond 2^53 intermediate products", () => {
    const line = computeLine({ quantity: 999_999.99, unit_amount_minor: 9_000_000_000, discount_minor: 0, tax_rate_bps: 0 });
    expect(line.gross_minor).toBe(8_999_999_910_000_000);
  });

  it.each([
    [{ quantity: 0, unit_amount_minor: 100, discount_minor: 0, tax_rate_bps: 0 }],
    [{ quantity: 1.005, unit_amount_minor: 100, discount_minor: 0, tax_rate_bps: 0 }],
    [{ quantity: 1, unit_amount_minor: -1, discount_minor: 0, tax_rate_bps: 0 }],
    [{ quantity: 1, unit_amount_minor: 100, discount_minor: 101, tax_rate_bps: 0 }],
    [{ quantity: 1, unit_amount_minor: 100, discount_minor: 0, tax_rate_bps: 10_001 }],
    [{ quantity: 1, unit_amount_minor: 1.5, discount_minor: 0, tax_rate_bps: 0 }],
  ])("rejects invalid input %j", (line) => {
    expect(() => computeLine(line)).toThrow(RangeError);
  });

  it("totals match the database for the same lines", () => {
    expect(
      computeTotals([
        { quantity: 2.5, unit_amount_minor: 1_000_001, discount_minor: 0, tax_rate_bps: 1800 },
        { quantity: 1, unit_amount_minor: 5_000_000, discount_minor: 500_000, tax_rate_bps: 1800 },
      ]),
    ).toEqual({ subtotal_minor: 7_500_003, discount_minor: 500_000, tax_minor: 1_260_001, total_minor: 8_260_004 });
  });
});

describe("parsing and formatting", () => {
  it.each([
    ["25000", 2_500_000],
    ["25,000.5", 2_500_050],
    ["0.01", 1],
    [" 1 234.56 ", 123_456],
  ])("parses %s", (input, expected) => {
    expect(parseMajorToMinor(input)).toBe(expected);
  });

  it.each(["-5", "1.234", "abc", "", "1e5", "0.1.2"])("rejects %s", (input) => {
    expect(parseMajorToMinor(input)).toBeNull();
  });

  it("round-trips minor units to editor text", () => {
    expect(minorToMajorString(2_500_050)).toBe("25000.50");
    expect(parseMajorToMinor(minorToMajorString(1))).toBe(1);
  });

  it("formats INR with Indian grouping", () => {
    expect(formatMoney(123_456_789, "INR")).toMatch(/12,34,567\.89/);
  });
});

describe("payment schedule", () => {
  it("allocates percentages so instalments always sum to the total", () => {
    const amounts = scheduleAmounts(
      [
        { label: "A", basis: "percent", percent_bps: 3333, due: "on_signing" },
        { label: "B", basis: "percent", percent_bps: 3333, due: "on_milestone", milestone: "M1" },
        { label: "C", basis: "percent", percent_bps: 3334, due: "on_milestone", milestone: "M2" },
      ],
      100_001,
    );
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(100_001);
  });

  it("validates percentages and fixed amounts", () => {
    expect(validateSchedule([], 100)).toMatch(/at least one/);
    expect(validateSchedule([{ label: "A", basis: "percent", percent_bps: 9000, due: "on_signing" }], 100)).toMatch(/90%/);
    expect(validateSchedule([{ label: "A", basis: "percent", percent_bps: 10_000, due: "on_signing" }], 100)).toBeNull();
    expect(validateSchedule([{ label: "A", basis: "fixed", amount_minor: 99, due: "on_signing" }], 100)).toMatch(/add up/);
    expect(
      validateSchedule(
        [
          { label: "A", basis: "fixed", amount_minor: 50, due: "on_signing" },
          { label: "B", basis: "percent", percent_bps: 5000, due: "on_signing" },
        ],
        100,
      ),
    ).toMatch(/not both/);
  });
});
