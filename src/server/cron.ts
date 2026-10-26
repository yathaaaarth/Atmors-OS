import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { AppError } from "@/server/errors";

/**
 * Scheduler authentication. Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`; any other scheduler must do the same. Fails closed when the
 * secret is not configured.
 */
export function assertCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!secret || secret.length < 16 || !timingSafeEqual(digest(header), digest(`Bearer ${secret}`))) {
    throw new AppError("FORBIDDEN", { detail: "invalid cron credentials" });
  }
}
