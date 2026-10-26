import { assertCronRequest } from "@/server/cron";
import { handleRoute } from "@/server/http/route";
import { dispatchNotifications } from "@/server/jobs";

/** Sends due notifications. Safe to run concurrently and repeatedly. */
export const GET = handleRoute(async ({ request }) => {
  assertCronRequest(request);
  return dispatchNotifications();
});
