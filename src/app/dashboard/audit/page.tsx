import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 100;

function summarize(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

export default async function AuditLogPage() {
  const access = await memberPageAccess("/dashboard/audit", "audit.read");
  if (!access.allowed) return <AccessDenied />;

  const supabase = await createSupabaseServerClient();
  const { data: entries, error } = await supabase
    .from("audit_logs")
    .select("id, actor_type, actor_id, action, entity_type, before_summary, after_summary, reason, correlation_id, occurred_at")
    .eq("organization_id", access.context.organizationId)
    .order("occurred_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (error) throw fromPostgrestError(error);

  const actorIds = [...new Set((entries ?? []).map((entry) => entry.actor_id).filter((id): id is string => Boolean(id)))];
  const { data: actors } = actorIds.length
    ? await supabase.from("profiles").select("id, display_name, email").in("id", actorIds)
    : { data: [] };
  const actorName = new Map((actors ?? []).map((actor) => [actor.id, actor.display_name || actor.email || actor.id]));
  const formatter = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Append-only record of privileged changes. Showing the latest {PAGE_SIZE}; times in IST.
        </p>
      </header>
      {entries && entries.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Ref</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">{formatter.format(new Date(entry.occurred_at))}</TableCell>
                  <TableCell>
                    {entry.actor_id ? (actorName.get(entry.actor_id) ?? entry.actor_id) : entry.actor_type}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{entry.action}</code>
                    <span className="block text-xs text-muted-foreground">{entry.entity_type}</span>
                  </TableCell>
                  <TableCell className="max-w-xs text-xs">
                    <span className="block truncate">From {summarize(entry.before_summary)}</span>
                    <span className="block truncate">To {summarize(entry.after_summary)}</span>
                  </TableCell>
                  <TableCell className="max-w-xs text-sm whitespace-normal">{entry.reason ?? "—"}</TableCell>
                  <TableCell>
                    <code className="text-xs" title={entry.correlation_id}>
                      {entry.correlation_id.slice(0, 8)}
                    </code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No audited changes yet.</p>
      )}
    </div>
  );
}
