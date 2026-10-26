import { NextResponse } from "next/server";

import { handleRoute } from "@/server/http/route";
import { RATE_RULES, assertRateLimit } from "@/server/rate-limit";
import { ingestSignatureWebhook } from "@/server/integrations/ingest";

/** E-signature provider webhooks; same contract as the payment webhook route. */
export const POST = handleRoute<{ provider: string }>(async ({ request, params, correlationId }) => {
  await assertRateLimit(RATE_RULES.webhook, undefined, request.headers);
  const outcome = await ingestSignatureWebhook(params.provider, await request.text(), request.headers, correlationId);
  return NextResponse.json({ status: outcome.status }, { status: outcome.httpStatus });
});
