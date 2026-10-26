import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/modules/proposals/money";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "Agreements" };

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export default async function ContractsPage() {
  const access = await memberPageAccess("/dashboard/contracts", "contracts.read");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;

  const supabase = await createSupabaseServerClient();
  const { data: contracts, error } = await supabase
    .from("contracts")
    .select("id, title, status, total_minor, currency, sent_at, executed_at, created_at, supersedes_contract_id, activation_eligible, prospects(name, company)")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw fromPostgrestError(error);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Agreements</h1>
          <p className="text-sm text-muted-foreground">
            Generated from accepted proposal versions. Open an accepted proposal to generate its agreement.
          </p>
        </div>
        {can(context, "contracts.templates") ? (
          <Button asChild variant="outline">
            <Link href="/dashboard/contracts/templates">Templates</Link>
          </Button>
        ) : null}
      </header>

      {(contracts ?? []).length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">No agreements yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agreement</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Activation</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(contracts ?? []).map((contract) => (
                <TableRow key={contract.id}>
                  <TableCell>
                    <Link href={`/dashboard/contracts/${contract.id}`} className="font-medium hover:underline">
                      {contract.title}
                    </Link>
                    {contract.supersedes_contract_id ? <span className="block text-xs text-muted-foreground">Amendment</span> : null}
                  </TableCell>
                  <TableCell>{contract.prospects?.company ?? contract.prospects?.name}</TableCell>
                  <TableCell>
                    <StatusBadge status={contract.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(contract.total_minor, contract.currency)}</TableCell>
                  <TableCell className="text-sm">
                    {contract.supersedes_contract_id ? "—" : contract.activation_eligible ? "Eligible" : "Blocked"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {dateFormat.format(new Date(contract.executed_at ?? contract.sent_at ?? contract.created_at))}
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
