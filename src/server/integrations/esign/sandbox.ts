import { hmacSha256Hex, safeEqualHex } from "../crypto";
import { SANDBOX_SIGNATURE_HEADER } from "../payments/sandbox";
import type { EsignProvider, NormalizedSignatureEvent, SignerRole } from "./types";

export type SandboxSignatureBody = {
  id: string;
  type: string;
  document_id: string;
  occurred_at: string;
  signer?: { role: SignerRole; email: string };
};

export type SandboxEsignProvider = EsignProvider & {
  signedEvent(body: SandboxSignatureBody): { rawBody: string; headers: Headers };
};

/**
 * Development e-signature provider. The "signing ceremony" is an
 * authenticated page in this app; the result arrives as an HMAC-signed event
 * through the same ingest path a real vendor's webhook would use.
 */
export function sandboxEsignProvider(secret: string): SandboxEsignProvider {
  return {
    id: "sandbox",

    async createEnvelope(input) {
      // Deterministic, so a retried send never creates a second envelope.
      return { providerDocumentId: `sbx_doc_${input.contractId}` };
    },

    verifyWebhook(rawBody, headers) {
      return safeEqualHex(hmacSha256Hex(secret, rawBody), headers.get(SANDBOX_SIGNATURE_HEADER));
    },

    parseWebhook(rawBody): NormalizedSignatureEvent | null {
      try {
        const body = JSON.parse(rawBody) as Partial<SandboxSignatureBody>;
        if (typeof body.id !== "string" || typeof body.type !== "string" || typeof body.document_id !== "string") return null;
        return {
          eventId: body.id.slice(0, 200),
          type: body.type,
          providerDocumentId: body.document_id,
          occurredAt: typeof body.occurred_at === "string" ? body.occurred_at : null,
          data: body.signer ? { signer_role: body.signer.role, signer_email: body.signer.email } : {},
        };
      } catch {
        return null;
      }
    },

    signedEvent(body) {
      const rawBody = JSON.stringify(body);
      return { rawBody, headers: new Headers({ [SANDBOX_SIGNATURE_HEADER]: hmacSha256Hex(secret, rawBody) }) };
    },
  };
}
