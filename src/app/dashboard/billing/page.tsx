import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/modules/proposals/money";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";
import { configureIntegration, reprocessPaymentEvent, runBillingChecks } from "./actions";

export const metadata: Metadata = { title: "Billing" };

const STATUSES = ["issued", "partially_paid", "overdue", "disputed", "paid", "voided"] as const;
const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

const exceptionSchema = z.array(
  z.object({
    kind: z.enum(["payment", "signature"]),
    id: z.uuid(),
    provider: z.string(),
    event_type: z.string(),
    processing_status: z.string(),
    error_code: z.string().nullable(),
    received_at: z.string(),
    signature_verified: z.boolean(),
  }),
);

export default async function BillingPage(props: PageProps<"/dashboard/billing">) {
  const access = await memberPageAccess("/dashboard/billing");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  const finance = can(context, "finance.read");
  if (!finance && !can(context, "integrations.monitor")) return <AccessDenied />;

  const params = await props.searchParams;
  const status = typeof params.status === "string" && (STATUSES as readonly string[]).includes(params.status)
    ? (params.status as (typeof STATUSES)[number])
    : undefined;

  const supabase = await createSupabaseServerClient();
  let invoiceQuery = supabase
    .from("invoices")
    .select("id, invoice_number, label, status, currency, total_minor, balance_minor, due_at, prospects(name, company)")
    .eq("organization_id", context.organizationId)
    .order("issued_at", { ascending: false })
    .limit(200);
  if (status) invoiceQuery = invoiceQuery.eq("status", status);

  const [invoices, exceptions, accounts] = await Promise.all([
    finance ? invoiceQuery : Promise.resolve({ data: [], error: null }),
    supabase.rpc("integration_exceptions", { p_organization_id: context.organizationId }),
    supabase.from("integration_accounts").select("*").eq("organization_id", context.organizationId).order("kind"),
  ]);
  if (invoices.error) throw fromPostgrestError(invoices.error);
  if (exceptions.error) throw fromPostgrestError(exceptions.error);
  if (accounts.error) throw fromPostgrestError(accounts.error);
  const exceptionRows = exceptionSchema.parse(exceptions.data ?? []);
  const canManage = can(context, "billing.manage");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Invoices follow each agreement&apos;s own payment schedule. Balances change only on verified provider events or
            recorded reconciliation.
          </p>
        </div>
        {canManage ? (
          <ActionForm action={runBillingChecks} submitLabel="Run billing checks" variant="outline" successMessage="Done.">
            <span className="block text-xs text-muted-foreground">Issues dated instalments and flags overdue invoices.</span>
          </ActionForm>
        ) : null}
      </header>

      {finance ? (
        <section aria-labelledby="invoices" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <h2 id="invoices" className="mr-2 font-heading text-lg font-semibold">
              Invoices
            </h2>
            <Link href="/dashboard/billing" className={!status ? "font-medium underline" : "text-muted-foreground hover:underline"}>
              All
            </Link>
            {STATUSES.map((value) => (
              <Link
                key={value}
                href={`/dashboard/billing?status=${value}`}
                className={status === value ? "font-medium underline" : "text-muted-foreground hover:underline"}
              >
                <StatusBadge status={value} />
              </Link>
            ))}
          </div>
          {(invoices.data ?? []).length === 0 ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">No invoices{status ? " with this status" : ""}.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Due</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(invoices.data ?? []).map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>
                        <Link href={`/dashboard/billing/invoices/${invoice.id}`} className="font-medium hover:underline">
                          {invoice.invoice_number}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{invoice.label}</span>
                      </TableCell>
                      <TableCell>{invoice.prospects?.company ?? invoice.prospects?.name}</TableCell>
                      <TableCell>
                        <StatusBadge status={invoice.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(invoice.total_minor, invoice.currency)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(invoice.balance_minor, invoice.currency)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {invoice.due_at ? dateFormat.format(new Date(invoice.due_at)) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Provider exceptions</CardTitle>
          <CardDescription>
            Quarantined payment and signature events. Forged (unverified) events are kept as evidence and never replayed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {exceptionRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No quarantined events.</p>
          ) : (
            <ul className="divide-y text-sm">
              {exceptionRows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium">{row.kind === "payment" ? "Payment" : "Signature"}</span> · {row.provider} ·{" "}
                    {row.event_type}
                    <span className="block text-xs text-muted-foreground">
                      {row.error_code} · {dateTime.format(new Date(row.received_at))}
                      {row.signature_verified ? "" : " · signature invalid"}
                    </span>
                  </span>
                  {row.kind === "payment" && row.signature_verified && canManage ? (
                    <ActionForm action={reprocessPaymentEvent} submitLabel="Replay" variant="outline" successMessage="Replayed.">
                      <input type="hidden" name="eventId" value={row.id} />
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Providers enabled for {context.organizationName}</CardTitle>
          <CardDescription>
            Events are processed only for an enabled provider, and payment events must come from this merchant account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(accounts.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(accounts.data ?? []).map((account) => (
                <li key={`${account.kind}-${account.provider}`}>
                  {account.kind === "payments" ? "Payments" : "E-signature"} · {account.provider} · <code>{account.account_id}</code> ·{" "}
                  {account.active ? "active" : "inactive"}
                </li>
              ))}
            </ul>
          )}
          {canManage || can(context, "contracts.manage") ? (
            <ActionForm action={configureIntegration} submitLabel="Save provider" variant="outline" className="grid gap-3 space-y-0 sm:grid-cols-4 sm:items-end">
              <div className="space-y-1">
                <Label htmlFor="int-kind">Kind</Label>
                <select id="int-kind" name="kind" className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {canManage ? <option value="payments">Payments</option> : null}
                  {can(context, "contracts.manage") ? <option value="esign">E-signature</option> : null}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="int-provider">Provider</Label>
                <Input id="int-provider" name="provider" placeholder="razorpay" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="int-account">Account / merchant ID</Label>
                <Input id="int-account" name="accountId" placeholder="acc_…" required />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" name="active" defaultChecked /> Active
              </label>
            </ActionForm>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
