import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeBlockingReason } from "@/modules/contracts/schema";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "Workspaces" };

export default async function WorkspacesPage() {
  const access = await memberPageAccess("/dashboard/workspaces");
  if (!access.allowed) return <AccessDenied />;
  const supabase = await createSupabaseServerClient();
  // RLS: everything with workspaces.read_all; otherwise only assigned workspaces.
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, client_name, status, delivery_status, blocked_reasons, override_active, activated_at")
    .eq("organization_id", access.context.organizationId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw fromPostgrestError(error);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Workspaces</h1>
        <p className="text-sm text-muted-foreground">
          One per client, created when the agreement is executed. Delivery staff see only workspaces they are assigned to.
        </p>
      </header>
      {(data ?? []).length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">No workspaces you can see yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Blocked by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/dashboard/workspaces/${row.id}`} className="font-medium hover:underline">
                      {row.client_name}
                    </Link>
                    {row.override_active ? <span className="ml-2 rounded border border-amber-500/50 px-1.5 text-xs">Manual override</span> : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.delivery_status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.status === "blocked" ? row.blocked_reasons.map((reason) => describeBlockingReason(reason)).join("; ") : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
