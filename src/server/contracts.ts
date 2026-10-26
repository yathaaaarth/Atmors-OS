import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError, fromPostgrestError } from "@/server/errors";
import { envelopeProviderId, esignProvider, sandboxEsign } from "@/server/integrations/esign/registry";
import type { SignerRole } from "@/server/integrations/esign/types";
import { ingestSignatureWebhook } from "@/server/integrations/ingest";
import { createSupabaseServerClient } from "@/server/supabase/server";

const signingTargetSchema = z.object({
  provider: z.string(),
  provider_document_id: z.string(),
  signer_role: z.enum(["client", "atmors"]),
  signer_email: z.string(),
});

/**
 * Create the provider envelope from the frozen snapshot, then record it. The
 * sandbox envelope ID is deterministic and record_contract_sent is
 * idempotent, so a retry after a partial failure does not double-send.
 */
export async function sendContractForSignature(contractId: string, correlationId: string): Promise<void> {
  const providerId = envelopeProviderId();
  const provider = providerId ? esignProvider(providerId) : null;
  if (!provider) throw new AppError("PROVIDER_UNAVAILABLE", { detail: "no e-signature provider configured" });

  const supabase = await createSupabaseServerClient();
  const { data: contract, error } = await supabase
    .from("contracts")
    .select("id, title, status, rendered_document, checksum, contract_signers(role, name, email, position)")
    .eq("id", contractId)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!contract) throw new AppError("NOT_FOUND");
  if (contract.status !== "ready_to_send") {
    throw new AppError("INVALID_STATE_TRANSITION", { message: "Mark the agreement ready before sending it." });
  }

  const { providerDocumentId } = await provider.createEnvelope({
    contractId: contract.id,
    title: contract.title,
    documentText: contract.rendered_document,
    checksum: contract.checksum,
    signers: contract.contract_signers.map((signer) => ({
      role: signer.role as SignerRole,
      name: signer.name,
      email: signer.email,
      order: signer.position,
    })),
  });

  const { error: sentError } = await supabase.rpc("record_contract_sent", {
    p_contract_id: contract.id,
    p_provider: provider.id,
    p_provider_document_id: providerDocumentId,
    p_correlation_id: correlationId,
  });
  if (sentError) throw fromPostgrestError(sentError);
}

/** Sandbox signing ceremony: the database has already authorized the signer. */
async function emitSandboxSignature(target: z.infer<typeof signingTargetSchema>, correlationId: string) {
  if (target.provider !== "sandbox") {
    // A real vendor returns its own signing URL; that adapter is not chosen yet.
    throw new AppError("PROVIDER_UNAVAILABLE", { detail: `signing ceremony for ${target.provider} is not implemented` });
  }
  const sandbox = sandboxEsign();
  if (!sandbox) throw new AppError("PROVIDER_UNAVAILABLE", { detail: "sandbox e-signature is disabled" });
  const { rawBody, headers } = sandbox.signedEvent({
    id: `sbx_sig_${randomUUID()}`,
    type: "signer.signed",
    document_id: target.provider_document_id,
    occurred_at: new Date().toISOString(),
    signer: { role: target.signer_role, email: target.signer_email },
  });
  const outcome = await ingestSignatureWebhook("sandbox", rawBody, headers, correlationId);
  if (outcome.status === "quarantined") {
    throw new AppError("INTERNAL_ERROR", { detail: `signature event quarantined: ${outcome.errorCode}` });
  }
}

/**
 * AT-004: signing needs a signed-in client whose email is the named signer,
 * looking at the exact document checksum. client_prepare_signature enforces it.
 */
export async function signAsClient(contractId: string, checksum: string, correlationId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_prepare_signature", {
    p_contract_id: contractId,
    p_checksum: checksum,
    p_correlation_id: correlationId,
  });
  if (error) throw fromPostgrestError(error);
  await emitSandboxSignature(signingTargetSchema.parse(data), correlationId);
}

export async function countersign(contractId: string, checksum: string, correlationId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("prepare_countersignature", {
    p_contract_id: contractId,
    p_checksum: checksum,
    p_correlation_id: correlationId,
  });
  if (error) throw fromPostgrestError(error);
  await emitSandboxSignature(signingTargetSchema.parse(data), correlationId);
}
