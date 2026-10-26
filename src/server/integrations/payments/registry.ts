import "server-only";

import { razorpayConfig, sandboxProvidersEnabled, sandboxWebhookSecret } from "../config";
import { razorpayProvider } from "./razorpay";
import { sandboxPaymentProvider, type SandboxPaymentProvider } from "./sandbox";
import type { PaymentProvider } from "./types";

/** The configured adapter for a provider ID, or null when it is not available here. */
export function paymentProvider(id: string): PaymentProvider | null {
  if (id === "razorpay") {
    const config = razorpayConfig();
    return config ? razorpayProvider(config) : null;
  }
  if (id === "sandbox") return sandboxPayments();
  return null;
}

export function sandboxPayments(): SandboxPaymentProvider | null {
  return sandboxProvidersEnabled() ? sandboxPaymentProvider(sandboxWebhookSecret()) : null;
}

/** Which provider new payments use: PAYMENTS_PROVIDER, else Razorpay when configured, else the sandbox. */
export function checkoutProviderId(): string | null {
  const preferred = process.env.PAYMENTS_PROVIDER;
  if (preferred) return paymentProvider(preferred) ? preferred : null;
  if (razorpayConfig()) return "razorpay";
  return sandboxProvidersEnabled() ? "sandbox" : null;
}
