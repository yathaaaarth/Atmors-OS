/**
 * Provider-independent e-signature adapter contract (PRD §5.5, §10). The
 * vendor is not chosen yet (provider register); nothing in the domain model
 * depends on a specific vendor's behaviour.
 */

export type SignerRole = "client" | "atmors";

export type NormalizedSignatureEventType = "document.viewed" | "signer.signed" | "signer.declined" | "document.completed";

export type NormalizedSignatureEvent = {
  eventId: string;
  type: NormalizedSignatureEventType | (string & {});
  providerDocumentId: string | null;
  occurredAt: string | null;
  data: { signer_role?: SignerRole; signer_email?: string };
};

export type EnvelopeInput = {
  contractId: string;
  title: string;
  /** The immutable rendered snapshot and its checksum. */
  documentText: string;
  checksum: string;
  signers: { role: SignerRole; name: string; email: string; order: number }[];
};

export interface EsignProvider {
  readonly id: string;
  /** Create a signature request from the snapshot. Must be idempotent per contract. */
  createEnvelope(input: EnvelopeInput): Promise<{ providerDocumentId: string }>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseWebhook(rawBody: string, headers: Headers): NormalizedSignatureEvent | null;
}
