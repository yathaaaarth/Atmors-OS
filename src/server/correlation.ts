export const CORRELATION_HEADER = "x-correlation-id";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

/** Accept an inbound correlation ID only if it is well-formed; otherwise mint one. */
export function resolveCorrelationId(inbound: string | null | undefined): string {
  return inbound && CORRELATION_ID_PATTERN.test(inbound) ? inbound : newCorrelationId();
}
