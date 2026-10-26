import { hmacSha256Hex, safeEqualHex } from "../crypto";
import type { NormalizedPaymentData, NormalizedPaymentEvent, PaymentProvider } from "./types";

/** The merchant account that sandbox events claim; enable it per organization. */
export const SANDBOX_PAYMENT_ACCOUNT = "acc_sandbox";
export const SANDBOX_SIGNATURE_HEADER = "x-sandbox-signature";

export type SandboxPaymentBody = { id: string; type: string; data: NormalizedPaymentData };

export type SandboxPaymentProvider = PaymentProvider & {
  /** A webhook body and headers signed exactly as the webhook route expects. */
  signedEvent(body: SandboxPaymentBody): { rawBody: string; headers: Headers };
};

/** Development provider: orders are local and events are HMAC-signed with a server secret. */
export function sandboxPaymentProvider(secret: string): SandboxPaymentProvider {
  return {
    id: "sandbox",

    async createOrder(input) {
      return { providerOrderId: `sbx_order_${input.paymentId}` };
    },

    checkout(input) {
      return { kind: "redirect", url: `/portal/pay/sandbox/${input.paymentId}` };
    },

    verifyWebhook(rawBody, headers) {
      return safeEqualHex(hmacSha256Hex(secret, rawBody), headers.get(SANDBOX_SIGNATURE_HEADER));
    },

    parseWebhook(rawBody): NormalizedPaymentEvent | null {
      try {
        const body = JSON.parse(rawBody) as Partial<SandboxPaymentBody>;
        if (typeof body.id !== "string" || typeof body.type !== "string" || typeof body.data !== "object" || !body.data) {
          return null;
        }
        return { eventId: body.id.slice(0, 200), type: body.type, data: body.data };
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
