/**
 * Request-time clock helpers. Server components render once per request, so
 * reading the clock is intended; keeping it here makes that explicit.
 */
export function isPast(iso: string | null | undefined): boolean {
  return iso ? new Date(iso).getTime() < Date.now() : false;
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** [now, now + days) for availability lookups. */
export function windowFromNow(days: number): { from: Date; to: Date } {
  const from = new Date();
  return { from, to: new Date(from.getTime() + days * 86_400_000) };
}
