import "server-only";

import { AppError, fromPostgrestError } from "@/server/errors";
import { logger } from "@/server/logger";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { sha256Hex } from "./crypto";
import { esignProvider } from "./esign/registry";
import { paymentProvider } from "./payments/registry";
import type { NormalizedPaymentEvent } from "./payments/types";

export type IngestOutcome = {
  /** HTTP status for the provider: 2xx stops retries, 401 rejects a bad signature. */
  httpStatus: number;
  status: string;
  errorCode: string | null;
};

const MAX_BODY_BYTES = 256 * 1024;

async function verify(check: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

function assertSize(rawBody: string) {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_FAILED", { message: "Webhook body is too large." });
  }
}

/**
 * Record a payment webhook: verify the signature here (the secret is
 * server-side), then hand the normalized event to the database, which
 * deduplicates on the provider event ID and applies it in one transaction.
 * Unverified events are stored quarantined and change nothing (AT-014).
 */
export async function ingestPaymentWebhook(
  providerId: string,
  rawBody: string,
  headers: Headers,
  correlationId: string,
): Promise<IngestOutcome> {
  const provider = paymentProvider(providerId);
  if (!provider) throw new AppError("NOT_FOUND", { detail: `payment provider ${providerId} is not enabled` });
  assertSize(rawBody);

  const event = (await verify(() => provider.verifyWebhook(rawBody, headers))) ? provider.parseWebhook(rawBody, headers) : null;
  return recordPaymentEvent(provider.id, event, rawBody, correlationId);
}

async function recordPaymentEvent(
  providerId: string,
  event: NormalizedPaymentEvent | null,
  rawBody: string,
  correlationId: string,
): Promise<IngestOutcome> {
  const provider = { id: providerId };
  const payloadHash = sha256Hex(rawBody);
  const { data, error } = await createSupabaseAdminClient().rpc("ingest_payment_event", {
    p_provider: provider.id,
    p_provider_event_id: event?.eventId ?? `unverified:${payloadHash}`,
    p_event_type: event?.type ?? "unverified",
    p_signature_verified: event !== null,
    p_payload_hash: payloadHash,
    p_data: event?.data ?? {},
    p_correlation_id: correlationId,
  });
  if (error) throw fromPostgrestError(error);

  const result = data as { status: string; error_code?: string | null };
  logger[result.status === "quarantined" ? "warn" : "info"]("webhook.payment", {
    correlation_id: correlationId,
    provider: provider.id,
    event_type: event?.type ?? "unverified",
    status: result.status,
    error_code: result.error_code ?? null,
  });
  return { httpStatus: event ? 200 : 401, status: result.status, errorCode: result.error_code ?? null };
}

export async function ingestSignatureWebhook(
  providerId: string,
  rawBody: string,
  headers: Headers,
  correlationId: string,
): Promise<IngestOutcome> {
  const provider = esignProvider(providerId);
  if (!provider) throw new AppError("NOT_FOUND", { detail: `e-signature provider ${providerId} is not enabled` });
  assertSize(rawBody);

  const event = (await verify(() => provider.verifyWebhook(rawBody, headers))) ? provider.parseWebhook(rawBody, headers) : null;
  const payloadHash = sha256Hex(rawBody);
  const { data, error } = await createSupabaseAdminClient().rpc("ingest_signature_event", {
    p_provider: provider.id,
    p_provider_event_id: event?.eventId ?? `unverified:${payloadHash}`,
    p_event_type: event?.type ?? "unverified",
    p_signature_verified: event !== null,
    p_payload_hash: payloadHash,
    p_provider_document_id: event?.providerDocumentId ?? (null as unknown as string),
    p_data: event?.data ?? {},
    p_occurred_at: event?.occurredAt ?? (null as unknown as string),
    p_correlation_id: correlationId,
  });
  if (error) throw fromPostgrestError(error);

  const result = data as { status: string; error_code?: string | null };
  logger[result.status === "quarantined" ? "warn" : "info"]("webhook.signature", {
    correlation_id: correlationId,
    provider: provider.id,
    event_type: event?.type ?? "unverified",
    status: result.status,
    error_code: result.error_code ?? null,
  });
  return { httpStatus: event ? 200 : 401, status: result.status, errorCode: result.error_code ?? null };
}
