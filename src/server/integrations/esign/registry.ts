import "server-only";

import { sandboxProvidersEnabled, sandboxWebhookSecret } from "../config";
import { internalEsignProvider } from "./internal";
import { sandboxEsignProvider, type SandboxEsignProvider } from "./sandbox";
import type { EsignProvider } from "./types";

/**
 * Available e-signature providers. "internal" is the built-in signer and is
 * production-safe; "sandbox" is for development only. A vendor adapter
 * (once one is approved) implements EsignProvider and is registered here.
 */
export function esignProvider(id: string): EsignProvider | null {
  if (id === "internal") return internalEsignProvider();
  if (id === "sandbox") return sandboxEsign();
  return null;
}

export function sandboxEsign(): SandboxEsignProvider | null {
  return sandboxProvidersEnabled() ? sandboxEsignProvider(sandboxWebhookSecret()) : null;
}

/** The provider new envelopes go to: ESIGN_PROVIDER, else the sandbox in development, else the built-in signer. */
export function envelopeProviderId(): string | null {
  const preferred = process.env.ESIGN_PROVIDER || (sandboxProvidersEnabled() ? "sandbox" : "internal");
  return esignProvider(preferred) ? preferred : null;
}
