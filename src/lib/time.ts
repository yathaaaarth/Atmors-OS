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
