import type { EsignProvider } from "./types";

/**
 * Built-in e-signature (D-029). The signing ceremony runs in ClientOS: the
 * signer is signed in, confirms an emailed one-time code, types their name,
 * and signs the exact document checksum. Evidence is recorded by the
 * database (complete_internal_signature), so there are no inbound webhooks.
 */
export function internalEsignProvider(): EsignProvider {
  return {
    id: "internal",
    async createEnvelope(input) {
      // Deterministic: a retried send never creates a second document.
      return { providerDocumentId: `int_doc_${input.contractId}` };
    },
    verifyWebhook: () => false,
    parseWebhook: () => null,
  };
}
