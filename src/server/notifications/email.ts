import "server-only";

import { logger } from "@/server/logger";

/** Email adapter contract (PRD §10). Sends must be safe to retry: the outbox key deduplicates. */
export type SendResult = { ok: true; messageId: string } | { ok: false; error: string; permanent: boolean };

export interface EmailProvider {
  readonly id: string;
  send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<SendResult>;
}

/** Resend (proposed in the provider register). Uses its documented REST API and idempotency header. */
function resendProvider(apiKey: string, from: string): EmailProvider {
  return {
    id: "resend",
    async send(input) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": input.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const body = (await response.json()) as { id?: string };
          return { ok: true, messageId: body.id ?? "unknown" };
        }
        // 4xx other than rate limiting will not succeed on retry.
        return { ok: false, error: `resend HTTP ${response.status}`, permanent: response.status >= 400 && response.status < 500 && response.status !== 429 };
      } catch (error) {
        return { ok: false, error: `resend request failed: ${(error as Error).message}`, permanent: false };
      }
    },
  };
}

/** Development provider: logs the message instead of sending it. */
const logProvider: EmailProvider = {
  id: "log",
  async send(input) {
    logger.info("email.log_provider", { to_domain: input.to.split("@")[1], subject: input.subject, key: input.idempotencyKey });
    return { ok: true, messageId: `log-${input.idempotencyKey}` };
  },
};

export function emailProvider(): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (apiKey && from) return resendProvider(apiKey, from);
  return logProvider;
}
