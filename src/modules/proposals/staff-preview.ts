import { clientVersionSchema, type ClientVersion } from "./client-view";

type VersionRow = {
  id: string;
  version_number: number;
  currency: string;
  valid_until: string | null;
  content: unknown;
  payment_schedule: unknown;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  content_hash: string | null;
  change_summary: string | null;
  sent_at: string | null;
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
  gross_minor: number;
  net_minor: number;
  tax_minor: number;
  total_minor: number;
};

/**
 * Build the client-facing shape from staff-readable rows so the internal
 * preview renders through the same component the client sees. Returns null if
 * the draft is not yet complete enough to render (e.g. malformed schedule).
 */
export function toClientVersion(version: VersionRow, lines: LineRow[], today: string): ClientVersion | null {
  const parsed = clientVersionSchema.safeParse({
    ...version,
    is_expired: version.valid_until ? version.valid_until < today : null,
    line_items: lines,
  });
  return parsed.success ? parsed.data : null;
}

export function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}
