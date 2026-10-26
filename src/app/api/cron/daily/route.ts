import { assertCronRequest } from "@/server/cron";
import { handleRoute } from "@/server/http/route";
import { runDailyChecks } from "@/server/jobs";

/** Billing checks, meeting reminders and stale-payment flags. Idempotent. */
export const GET = handleRoute(async ({ request }) => {
  assertCronRequest(request);
  return runDailyChecks();
});
