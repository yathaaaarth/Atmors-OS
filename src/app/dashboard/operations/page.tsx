import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { daysAgoIso } from "@/lib/time";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";
import { retryNotification } from "./actions";

export const metadata: Metadata = { title: "Operations health" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const JOBS = ["dispatch_notifications", "daily_checks"];

/** Exception queues and job health (PRD §5.9, §16): failed emails, job runs, provider exceptions, AI errors. */
export default async function OperationsPage() {
  const access = await memberPageAccess("/dashboard/operations", "operations.manage");
  if (!access.allowed) return <AccessDenied />;
  const org = access.context.organizationId;
  const supabase = await createSupabaseServerClient();

  const [failed, queued, runs, exceptions, aiErrors] = await Promise.all([
    supabase.from("notifications").select("id, template_key, recipient_email, attempts, last_error, updated_at").eq("organization_id", org).eq("status", "failed").order("updated_at", { ascending: false }).limit(50),
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq("organization_id", org).eq("status", "queued"),
    supabase.from("job_runs").select("job, status, started_at, finished_at, stats, error").order("started_at", { ascending: false }).limit(40),
    supabase.rpc("integration_exceptions", { p_organization_id: org }),
    supabase.from("ai_messages").select("id", { count: "exact", head: true }).eq("organization_id", org).eq("validation_status", "error").gte("created_at", daysAgoIso(1)),
  ]);
  for (const result of [failed, queued, runs, aiErrors]) {
    if (result.error) throw fromPostgrestError(result.error);
  }
  const latest = new Map<string, NonNullable<typeof runs.data>[number]>();
  for (const run of runs.data ?? []) if (!latest.has(run.job)) latest.set(run.job, run);
  const exceptionCount = Array.isArray(exceptions.data) ? exceptions.data.length : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Operations health</h1>
        <p className="text-sm text-muted-foreground">Background work and anything stuck. See docs/runbooks for what to do about each.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Emails waiting to send</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{queued.count ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Emails failed</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{failed.data?.length ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Quarantined provider events</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              <Link href="/dashboard/billing" className="hover:underline">
                {exceptionCount}
              </Link>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>AI provider errors (24h)</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{aiErrors.count ?? 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scheduled jobs</CardTitle>
          <CardDescription>Run by the scheduler through /api/cron/*. A job that hasn&apos;t run recently needs attention.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {JOBS.map((job) => {
              const run = latest.get(job);
              return (
                <li key={job} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{job.replaceAll("_", " ")}</span>
                    <span className="block text-xs text-muted-foreground">
                      {run ? `Last run ${dateTime.format(new Date(run.started_at))}: ${JSON.stringify(run.stats)}` : "Never run"}
                      {run?.error ? ` · ${run.error}` : ""}
                    </span>
                  </span>
                  <StatusBadge status={!run ? "pending" : run.status === "ok" ? "processed" : "failed"} />
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Failed emails</CardTitle>
          <CardDescription>Gave up after five attempts. Important changes are still visible in the dashboard and portal.</CardDescription>
        </CardHeader>
        <CardContent>
          {(failed.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y text-sm">
              {(failed.data ?? []).map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {row.template_key.replaceAll("_", " ")} → {row.recipient_email}
                    <span className="block text-xs text-muted-foreground">
                      {row.attempts} attempts · {row.last_error} · {dateTime.format(new Date(row.updated_at))}
                    </span>
                  </span>
                  <ActionForm action={retryNotification} submitLabel="Retry" variant="outline">
                    <input type="hidden" name="id" value={row.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
