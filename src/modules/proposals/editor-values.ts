import { minorToMajorString, parseMajorToMinor, type Currency } from "./money";
import { proposalDraftSchema, type ProposalDraftInput } from "./schema";

/**
 * Form-friendly representation of a draft: money and percentages are typed as
 * text so no value passes through floating point before conversion.
 */
export type EditorLine = {
  title: string;
  description: string;
  quantity: string;
  unit: string;
  unitAmount: string;
  discount: string;
  taxPercent: string;
  billing_timing: "upfront" | "milestone" | "monthly" | "on_completion";
};

export type EditorInstalment = {
  label: string;
  value: string;
  due: "on_acceptance" | "on_signing" | "on_date" | "on_milestone";
  due_date: string;
  milestone: string;
};

export type EditorValues = {
  title: string;
  currency: Currency;
  validUntil: string;
  summary: string;
  scope: string;
  deliverables: string;
  timeline: string;
  dependencies: string;
  assumptions: string;
  exclusions: string;
  terms: string;
  lineItems: EditorLine[];
  scheduleBasis: "percent" | "fixed";
  schedule: EditorInstalment[];
  proofIds: string[];
  nonStandardTerms: boolean;
  marginException: boolean;
};

export const EMPTY_LINE: EditorLine = {
  title: "",
  description: "",
  quantity: "1",
  unit: "",
  unitAmount: "",
  discount: "0",
  taxPercent: "18",
  billing_timing: "upfront",
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);

/** Convert editor text to an amount; percent and tax use the same 2-decimal parser. */
function hundredths(text: string): number | null {
  return parseMajorToMinor(text.trim() === "" ? "0" : text);
}

export type ConversionResult = { ok: true; input: ProposalDraftInput } | { ok: false; errors: string[] };

export function editorToDraftInput(versionId: string, values: EditorValues): ConversionResult {
  const errors: string[] = [];

  const lineItems = values.lineItems.map((line, index) => {
    const unitAmount = parseMajorToMinor(line.unitAmount);
    const discount = hundredths(line.discount);
    const tax = hundredths(line.taxPercent);
    const quantity = Number(line.quantity);
    if (unitAmount === null) errors.push(`Line ${index + 1}: enter a price like 25000 or 25000.50.`);
    if (discount === null) errors.push(`Line ${index + 1}: discount must be an amount.`);
    if (tax === null || (tax ?? 0) > 10_000) errors.push(`Line ${index + 1}: tax must be 0–100%.`);
    if (!Number.isFinite(quantity) || quantity <= 0) errors.push(`Line ${index + 1}: quantity must be above zero.`);
    return {
      title: line.title.trim(),
      description: line.description.trim() || undefined,
      quantity,
      unit: line.unit.trim() || undefined,
      unit_amount_minor: unitAmount ?? 0,
      discount_minor: discount ?? 0,
      tax_rate_bps: tax ?? 0,
      billing_timing: line.billing_timing,
    };
  });

  const paymentSchedule = values.schedule.map((item, index) => {
    const amount = hundredths(item.value);
    if (amount === null || amount <= 0) errors.push(`Instalment ${index + 1}: enter a positive value.`);
    const base = {
      label: item.label.trim(),
      due: item.due,
      due_date: item.due === "on_date" && item.due_date ? item.due_date : undefined,
      milestone: item.due === "on_milestone" ? item.milestone.trim() || undefined : undefined,
    };
    return values.scheduleBasis === "percent"
      ? { ...base, basis: "percent" as const, percent_bps: amount ?? 0 }
      : { ...base, basis: "fixed" as const, amount_minor: amount ?? 0 };
  });

  if (errors.length > 0) return { ok: false, errors };

  const parsed = proposalDraftSchema.safeParse({
    versionId,
    title: values.title,
    currency: values.currency,
    validUntil: values.validUntil || null,
    content: {
      summary: values.summary,
      scope: values.scope,
      deliverables: lines(values.deliverables),
      timeline: values.timeline,
      dependencies: lines(values.dependencies),
      assumptions: lines(values.assumptions),
      exclusions: lines(values.exclusions),
      terms: values.terms,
    },
    paymentSchedule,
    lineItems,
    proofIds: values.proofIds,
    nonStandardTerms: values.nonStandardTerms,
    marginException: values.marginException,
  });
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`),
    };
  }
  return { ok: true, input: parsed.data };
}

type VersionRow = {
  currency: string;
  valid_until: string | null;
  content: unknown;
  payment_schedule: unknown;
  non_standard_terms: boolean;
  margin_exception: boolean;
};

type LineRow = {
  title: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_amount_minor: number;
  discount_minor: number;
  tax_rate_bps: number;
  billing_timing: string;
};

export function versionToEditorValues(
  title: string,
  version: VersionRow,
  lineRows: LineRow[],
  proofIds: string[],
): EditorValues {
  const content = (version.content ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof content[key] === "string" ? (content[key] as string) : "");
  const list = (key: string) => (Array.isArray(content[key]) ? (content[key] as string[]).join("\n") : "");
  const schedule = (Array.isArray(version.payment_schedule) ? version.payment_schedule : []) as Array<
    Record<string, unknown>
  >;
  const basis = schedule[0]?.basis === "fixed" ? "fixed" : "percent";

  return {
    title,
    currency: version.currency as Currency,
    validUntil: version.valid_until ?? "",
    summary: text("summary"),
    scope: text("scope"),
    deliverables: list("deliverables"),
    timeline: text("timeline"),
    dependencies: list("dependencies"),
    assumptions: list("assumptions"),
    exclusions: list("exclusions"),
    terms: text("terms"),
    lineItems: lineRows.map((line) => ({
      title: line.title,
      description: line.description ?? "",
      quantity: String(line.quantity),
      unit: line.unit ?? "",
      unitAmount: minorToMajorString(line.unit_amount_minor),
      discount: minorToMajorString(line.discount_minor),
      taxPercent: minorToMajorString(line.tax_rate_bps).replace(/\.00$/, ""),
      billing_timing: line.billing_timing as EditorLine["billing_timing"],
    })),
    scheduleBasis: basis,
    schedule: schedule.map((item) => ({
      label: String(item.label ?? ""),
      value: minorToMajorString(Number(basis === "percent" ? item.percent_bps : item.amount_minor) || 0).replace(
        basis === "percent" ? /\.00$/ : /$^/,
        "",
      ),
      due: (item.due as EditorInstalment["due"]) ?? "on_signing",
      due_date: String(item.due_date ?? ""),
      milestone: String(item.milestone ?? ""),
    })),
    proofIds,
    nonStandardTerms: version.non_standard_terms,
    marginException: version.margin_exception,
  };
}
