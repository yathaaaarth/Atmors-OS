import "server-only";

import { sandboxProvidersEnabled, sandboxWebhookSecret } from "../config";
import { sandboxEsignProvider, type SandboxEsignProvider } from "./sandbox";
import type { EsignProvider } from "./types";

/**
 * Only the sandbox exists until an e-signature vendor passes the provider
 * review (docs/decisions/provider-register.md). A vendor adapter implements
 * EsignProvider and is registered here.
 */
export function esignProvider(id: string): EsignProvider | null {
  if (id === "sandbox") return sandboxEsign();
  return null;
}

export function sandboxEsign(): SandboxEsignProvider | null {
  return sandboxProvidersEnabled() ? sandboxEsignProvider(sandboxWebhookSecret()) : null;
}

/** The provider new envelopes go to: ESIGN_PROVIDER, else the sandbox when enabled. */
export function envelopeProviderId(): string | null {
  const preferred = process.env.ESIGN_PROVIDER ?? (sandboxProvidersEnabled() ? "sandbox" : null);
  return preferred && esignProvider(preferred) ? preferred : null;
}
