import "server-only";

/**
 * Provider configuration from server-only environment variables. Secrets are
 * never NEXT_PUBLIC_ and never logged (PRD §10).
 */

/**
 * Sandbox providers simulate payment and signature events for development and
 * tests. They must never run in production: anyone with a client account
 * could otherwise "pay" an invoice. Two independent switches guard them: this
 * flag, and the organization's integration account (integration_accounts).
 */
export function sandboxProvidersEnabled(): boolean {
  return process.env.ENABLE_SANDBOX_PROVIDERS === "true" && process.env.VERCEL_ENV !== "production";
}

export function sandboxWebhookSecret(): string {
  const secret = process.env.SANDBOX_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SANDBOX_WEBHOOK_SECRET (32+ characters) is required when sandbox providers are enabled.");
  }
  return secret;
}

export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string };

export function razorpayConfig(): RazorpayConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  return keyId && keySecret && webhookSecret ? { keyId, keySecret, webhookSecret } : null;
}

export type PayPalEnvConfig = {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  merchantId: string;
  env: "live" | "sandbox";
};

/** PayPal for international clients. PAYPAL_ENV defaults to the PayPal sandbox; "live" takes real money. */
export function paypalConfig(): PayPalEnvConfig | null {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  const merchantId = process.env.PAYPAL_MERCHANT_ID;
  if (!clientId || !clientSecret || !webhookId || !merchantId) return null;
  return { clientId, clientSecret, webhookId, merchantId, env: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox" };
}
