import { NextResponse } from "next/server";

import { handleRoute } from "@/server/http/route";
import { ingestSignatureWebhook } from "@/server/integrations/ingest";

/** E-signature provider webhooks; same contract as the payment webhook route. */
export const POST = handleRoute<{ provider: string }>(async ({ request, params, correlationId }) => {
  const outcome = await ingestSignatureWebhook(params.provider, await request.text(), request.headers, correlationId);
  return NextResponse.json({ status: outcome.status }, { status: outcome.httpStatus });
});
