import { NextResponse } from "next/server";

import { handleRoute } from "@/server/http/route";
import { RATE_RULES, assertRateLimit } from "@/server/rate-limit";
import { ingestPaymentWebhook } from "@/server/integrations/ingest";

/**
 * Payment provider webhooks (PRD §9). Verify, persist idempotently, respond
 * promptly. Duplicates and quarantined-but-verified events still return 200
 * so the provider stops retrying; the exception queue handles them.
 */
export const POST = handleRoute<{ provider: string }>(async ({ request, params, correlationId }) => {
  await assertRateLimit(RATE_RULES.webhook, undefined, request.headers);
  const outcome = await ingestPaymentWebhook(params.provider, await request.text(), request.headers, correlationId);
  return NextResponse.json({ status: outcome.status }, { status: outcome.httpStatus });
});
