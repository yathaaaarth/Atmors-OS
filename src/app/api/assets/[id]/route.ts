import { NextResponse } from "next/server";

import { AppError } from "@/server/errors";
import { assetDownloadUrl } from "@/server/assets";
import { requireSessionUser } from "@/server/auth/session";
import { handleRoute } from "@/server/http/route";

/** Authorized, audited download through a 60-second signed URL. */
export const GET = handleRoute<{ id: string }>(async ({ params, correlationId }) => {
  await requireSessionUser();
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new AppError("NOT_FOUND");
  const url = await assetDownloadUrl(params.id, correlationId);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("cache-control", "no-store");
  return response;
});
