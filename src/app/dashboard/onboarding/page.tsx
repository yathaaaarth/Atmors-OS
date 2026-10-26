import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "Onboarding" };

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const ORDER = ["submitted", "resubmitted", "needs_information", "in_progress", "not_started", "approved"];

export default async function OnboardingListPage() {
  const access = await memberPageAccess("/dashboard/onboarding", "onboarding.manage");
  if (!access.allowed) return <AccessDenied />;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("onboardings")
    .select("id, status, updated_at, prospects(name, company)")
    .eq("organization_id", access.context.organizationId)
    .limit(300);
  if (error) throw fromPostgrestError(error);
  const rows = [...(data ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updated_at.localeCompare(a.updated_at));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Onboarding</h1>
          <p className="text-sm text-muted-foreground">Submissions waiting for review come first.</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/dashboard/onboarding/templates">Questionnaires</Link>
        </Button>
      </header>
      {rows.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">Onboarding starts when an agreement is executed.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/dashboard/onboarding/${row.id}`} className="font-medium hover:underline">
                      {row.prospects?.company ?? row.prospects?.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{dateFormat.format(new Date(row.updated_at))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
