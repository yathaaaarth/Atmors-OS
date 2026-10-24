/**
 * Money helpers. Amounts are integer minor units (paise, cents) carried as
 * numbers within the safe-integer range; arithmetic that can overflow uses
 * BigInt. Rounding matches the database exactly (half up on non-negatives).
 */

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD"] as const;
export type Currency = (typeof CURRENCIES)[number];

const LOCALE_BY_CURRENCY: Record<Currency, string> = {
  INR: "en-IN",
  USD: "en-US",
  EUR: "en-IE",
  GBP: "en-GB",
  AED: "en-AE",
  SGD: "en-SG",
  AUD: "en-AU",
  CAD: "en-CA",
};

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

/** Format minor units for display. All supported currencies use two decimals. */
export function formatMoney(minor: number, currency: string): string {
  const code = isCurrency(currency) ? currency : "INR";
  return new Intl.NumberFormat(LOCALE_BY_CURRENCY[code], { style: "currency", currency: code }).format(minor / 100);
}

/** "1,234.5" -> 123450. Returns null for anything that is not a plain non-negative amount. */
export function parseMajorToMinor(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, "");
  const match = /^(\d{1,13})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(minor);
}

export function minorToMajorString(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Quantity with at most two decimals, as hundredths. */
export function quantityToHundredths(quantity: number): bigint | null {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) return null;
  const hundredths = Math.round(quantity * 100);
  if (Math.abs(hundredths - quantity * 100) > 1e-6) return null;
  return BigInt(hundredths);
}

export type LineInput = {
  quantity: number;
  unit_amount_minor: number;
  discount_minor: number;
  tax_rate_bps: number;
};

export type LineAmounts = {
  gross_minor: number;
  net_minor: number;
  tax_minor: number;
  total_minor: number;
};

/** Same derivation as public.save_proposal_draft. Throws on invalid input. */
export function computeLine(line: LineInput): LineAmounts {
  const qty = quantityToHundredths(line.quantity);
  if (qty === null) throw new RangeError("quantity must be > 0 with at most two decimals");
  if (!Number.isSafeInteger(line.unit_amount_minor) || line.unit_amount_minor < 0) {
    throw new RangeError("unit amount must be a non-negative integer of minor units");
  }
  if (!Number.isSafeInteger(line.discount_minor) || line.discount_minor < 0) {
    throw new RangeError("discount must be a non-negative integer of minor units");
  }
  if (!Number.isInteger(line.tax_rate_bps) || line.tax_rate_bps < 0 || line.tax_rate_bps > 10_000) {
    throw new RangeError("tax rate must be 0-100%");
  }

  const gross = (qty * BigInt(line.unit_amount_minor) + 50n) / 100n;
  const discount = BigInt(line.discount_minor);
  if (discount > gross) throw new RangeError("discount exceeds the line amount");
  const net = gross - discount;
  const tax = (net * BigInt(line.tax_rate_bps) + 5_000n) / 10_000n;
  return {
    gross_minor: Number(gross),
    net_minor: Number(net),
    tax_minor: Number(tax),
    total_minor: Number(net + tax),
  };
}

export type Totals = {
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
};

export function computeTotals(lines: LineInput[]): Totals {
  let subtotal = 0n;
  let discount = 0n;
  let tax = 0n;
  for (const line of lines) {
    const amounts = computeLine(line);
    subtotal += BigInt(amounts.gross_minor);
    discount += BigInt(line.discount_minor);
    tax += BigInt(amounts.tax_minor);
  }
  return {
    subtotal_minor: Number(subtotal),
    discount_minor: Number(discount),
    tax_minor: Number(tax),
    total_minor: Number(subtotal - discount + tax),
  };
}

export type ScheduleItem =
  | { label: string; basis: "percent"; percent_bps: number; due: ScheduleDue; due_date?: string; milestone?: string }
  | { label: string; basis: "fixed"; amount_minor: number; due: ScheduleDue; due_date?: string; milestone?: string };

export type ScheduleDue = "on_acceptance" | "on_signing" | "on_date" | "on_milestone";

/** Resolve each instalment to minor units; the last percent instalment absorbs rounding. */
export function scheduleAmounts(schedule: ScheduleItem[], totalMinor: number): number[] {
  if (schedule.every((item) => item.basis === "fixed")) {
    return schedule.map((item) => (item.basis === "fixed" ? item.amount_minor : 0));
  }
  let allocated = 0n;
  return schedule.map((item, index) => {
    if (item.basis !== "percent") return 0;
    if (index === schedule.length - 1) return Number(BigInt(totalMinor) - allocated);
    const amount = (BigInt(totalMinor) * BigInt(item.percent_bps) + 5_000n) / 10_000n;
    allocated += amount;
    return Number(amount);
  });
}

/** Mirror of private.validate_payment_schedule; returns an error message or null. */
export function validateSchedule(schedule: ScheduleItem[], totalMinor: number): string | null {
  if (schedule.length === 0) return "Add at least one payment instalment.";
  const basis = schedule[0].basis;
  if (schedule.some((item) => item.basis !== basis)) return "Use either percentages or fixed amounts, not both.";
  if (basis === "percent") {
    const sum = schedule.reduce((acc, item) => acc + (item.basis === "percent" ? item.percent_bps : 0), 0);
    return sum === 10_000 ? null : `Percentages add up to ${sum / 100}%, not 100%.`;
  }
  const sum = schedule.reduce((acc, item) => acc + (item.basis === "fixed" ? item.amount_minor : 0), 0);
  return sum === totalMinor ? null : "Instalments must add up to the proposal total.";
}
