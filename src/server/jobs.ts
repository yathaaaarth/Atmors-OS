import "server-only";

import { publicEnv } from "@/lib/env";
import { fromPostgrestError } from "@/server/errors";
import { logger } from "@/server/logger";
import { emailProvider } from "@/server/notifications/email";
import { renderEmail } from "@/server/notifications/templates";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Background jobs, run by the scheduler (Vercel Cron or equivalent) through
 * /api/cron/*. Each is idempotent: running twice, or after a restore, does
 * not repeat side effects (AT-031, AT-034, AT-035).
 */

async function recordRun(job: string, startedAt: string, status: "ok" | "error", stats: Record<string, unknown>, error?: string) {
  await createSupabaseAdminClient().rpc("record_job_run", {
    p_job: job,
    p_status: status,
    p_stats: stats as never,
    p_error: (error ?? null) as string,
    p_started_at: startedAt,
  });
}

/** Send due notifications from the outbox. */
export async function dispatchNotifications(limit = 50): Promise<{ sent: number; failed: number; skipped: number }> {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();
  const provider = emailProvider();
  const stats = { sent: 0, failed: 0, skipped: 0 };
  try {
    const { data, error } = await admin.rpc("claim_notifications", { p_limit: limit });
    if (error) throw fromPostgrestError(error);
    for (const row of data ?? []) {
      const email = renderEmail(row.template_key, row.payload as Record<string, unknown>, publicEnv().NEXT_PUBLIC_SITE_URL);
      if (!email) {
        await admin.rpc("complete_notification", { p_id: row.id, p_ok: false, p_provider: provider.id, p_provider_message_id: null as unknown as string, p_error: "unknown template" });
        stats.skipped += 1;
        continue;
      }
      const result = await provider.send({ to: row.recipient_email, ...email, idempotencyKey: row.idempotency_key });
      if (!result.ok && result.permanent) {
        // Push straight to failed: retrying a permanent rejection only delays the exception.
        await admin.from("notifications").update({ attempts: 5 }).eq("id", row.id);
      }
      await admin.rpc("complete_notification", {
        p_id: row.id,
        p_ok: result.ok,
        p_provider: provider.id,
        p_provider_message_id: (result.ok ? result.messageId : null) as string,
        p_error: (result.ok ? null : result.error) as string,
      });
      if (result.ok) stats.sent += 1;
      else stats.failed += 1;
    }
    await recordRun("dispatch_notifications", startedAt, "ok", stats);
    return stats;
  } catch (error) {
    logger.error("job.dispatch_failed", { cause: error });
    await recordRun("dispatch_notifications", startedAt, "error", stats, (error as Error).message);
    throw error;
  }
}

/** Daily: billing checks per organization, meeting reminders, stale payments. */
export async function runDailyChecks(): Promise<Record<string, unknown>> {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();
  const stats: Record<string, unknown> = {};
  try {
    const { data: orgs, error } = await admin.from("organizations").select("id, slug");
    if (error) throw fromPostgrestError(error);
    for (const org of orgs ?? []) {
      const { data, error: billingError } = await admin.rpc("run_billing_checks", { p_organization_id: org.id, p_correlation_id: `cron-${startedAt}` });
      if (billingError) throw fromPostgrestError(billingError);
      stats[`billing:${org.slug}`] = data;
    }
    const { data: periodic, error: periodicError } = await admin.rpc("run_periodic_checks");
    if (periodicError) throw fromPostgrestError(periodicError);
    stats.periodic = periodic;
    await recordRun("daily_checks", startedAt, "ok", stats);
    return stats;
  } catch (error) {
    logger.error("job.daily_failed", { cause: error });
    await recordRun("daily_checks", startedAt, "error", stats, (error as Error).message);
    throw error;
  }
}
