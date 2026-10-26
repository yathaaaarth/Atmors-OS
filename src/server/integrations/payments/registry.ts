import "server-only";

import { publicEnv } from "@/lib/env";

import { paypalConfig, razorpayConfig, sandboxProvidersEnabled, sandboxWebhookSecret } from "../config";
import { PAYPAL_CURRENCIES, paypalProvider, type PayPalProvider } from "./paypal";
import { razorpayProvider } from "./razorpay";
import { sandboxPaymentProvider, type SandboxPaymentProvider } from "./sandbox";
import type { PaymentProvider } from "./types";

/** The configured adapter for a provider ID, or null when it is not available here. */
export function paymentProvider(id: string): PaymentProvider | null {
  if (id === "razorpay") {
    const config = razorpayConfig();
    return config ? razorpayProvider(config) : null;
  }
  if (id === "paypal") return paypalPayments();
  if (id === "sandbox") return sandboxPayments();
  return null;
}

export function paypalPayments(): PayPalProvider | null {
  const config = paypalConfig();
  return config ? paypalProvider({ ...config, appUrl: publicEnv().NEXT_PUBLIC_SITE_URL.replace(/\/$/, "") }) : null;
}

export function sandboxPayments(): SandboxPaymentProvider | null {
  return sandboxProvidersEnabled() ? sandboxPaymentProvider(sandboxWebhookSecret()) : null;
}

export type CheckoutOption = { provider: string; label: string; description: string };

const OPTION_TEXT: Record<string, Omit<CheckoutOption, "provider">> = {
  razorpay: { label: "Card, UPI or netbanking", description: "Secure checkout by Razorpay. International cards accepted." },
  paypal: { label: "PayPal", description: "Pay with your PayPal balance or a card through PayPal." },
  sandbox: { label: "Test checkout", description: "Development only; no money moves." },
};

/**
 * The online payment methods offered for an invoice currency, in display
 * order (all enabled methods without a currency). PAYMENTS_PROVIDER pins a single provider. The organization must also
 * have an active integration account for a provider, which the database
 * checks when the attempt starts.
 */
export function checkoutOptions(currency?: string): CheckoutOption[] {
  const preferred = process.env.PAYMENTS_PROVIDER;
  const candidates = preferred ? [preferred] : ["razorpay", "paypal", "sandbox"];
  return candidates
    .filter((id) => paymentProvider(id) !== null)
    .filter((id) => id !== "paypal" || !currency || (PAYPAL_CURRENCIES as readonly string[]).includes(currency))
    .map((provider) => ({ provider, ...OPTION_TEXT[provider] }));
}
