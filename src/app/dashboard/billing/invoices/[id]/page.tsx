import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney, minorToMajorString } from "@/modules/proposals/money";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../../member-page";
import { recordManualPayment, voidInvoice } from "../../actions";

export const metadata: Metadata = { title: "Invoice" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function InvoicePage(props: PageProps<"/dashboard/billing/invoices/[id]">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/billing/invoices/${id}`, "finance.read");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("*, prospects(name, company), contracts(id, title, client_legal_name)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!invoice) notFound();

  const [payments, events, adjustments] = await Promise.all([
    supabase.from("payments").select("*").eq("invoice_id", id).order("created_at", { ascending: false }),
    supabase
      .from("payment_events")
      .select("id, event_type, processing_status, error_code, signature_verified, received_at, provider")
      .eq("invoice_id", id)
      .order("received_at", { ascending: false })
      .limit(50),
    supabase.from("payment_adjustments").select("*, payments!inner(invoice_id)").eq("payments.invoice_id", id).order("occurred_at"),
  ]);
  for (const result of [payments, events, adjustments]) {
    if (result.error) throw fromPostgrestError(result.error);
  }

  const canManage = can(context, "billing.manage");
  const payable = ["issued", "partially_paid", "overdue"].includes(invoice.status);
  const voidable =
    invoice.status !== "voided" &&
    !(payments.data ?? []).some((payment) => ["succeeded", "refunded", "disputed", "pending"].includes(payment.status));
  const tax = invoice.tax_snapshot as { tax_minor?: number } | null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <Link href="/dashboard/billing" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Billing
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{invoice.invoice_number}</h1>
          <StatusBadge status={invoice.status} />
          <Link href={`/dashboard/billing/invoices/${invoice.id}/print`} className="text-sm underline underline-offset-4">
            Printable invoice
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          {invoice.label} · {invoice.prospects?.company ?? invoice.prospects?.name} ·{" "}
          {invoice.contracts ? (
            <Link href={`/dashboard/contracts/${invoice.contracts.id}`} className="underline underline-offset-4">
              {invoice.contracts.title}
            </Link>
          ) : null}
        </p>
      </header>

      <Card>
        <CardContent className="grid gap-4 pt-6 text-sm sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Total</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(invoice.total_minor, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Paid</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(invoice.paid_minor, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Balance</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(invoice.balance_minor, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Due</p>
            <p className="font-medium">{invoice.due_at ? dateTime.format(new Date(invoice.due_at)) : "—"}</p>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-4">
            Tax included (proportional estimate): {formatMoney(tax?.tax_minor ?? 0, invoice.currency)}. Invoice numbering, GST
            treatment and credit notes need review by a qualified accountant before production.
            {invoice.allow_partial ? " Part payments are allowed." : ""}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payments</CardTitle>
          <CardDescription>Every attempt is kept. Refunds and disputes adjust a payment; they never erase it.</CardDescription>
        </CardHeader>
        <CardContent>
          {(payments.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No payment attempts yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {(payments.data ?? []).map((payment) => (
                <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium tabular-nums">{formatMoney(payment.amount_minor, payment.currency)}</span> via{" "}
                    {payment.manual ? "manual reconciliation" : payment.provider}
                    {payment.manual ? (
                      <span className="ml-2 rounded border border-amber-500/50 px-1.5 text-xs">Manual override</span>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">
                      {dateTime.format(new Date(payment.created_at))}
                      {payment.manual_reference ? ` · ref ${payment.manual_reference}` : ""}
                      {payment.manual_reason ? ` · ${payment.manual_reason}` : ""}
                      {payment.refunded_minor > 0 ? ` · refunded ${formatMoney(payment.refunded_minor, payment.currency)}` : ""}
                      {payment.failure_code ? ` · ${payment.failure_code}` : ""}
                    </span>
                  </span>
                  <StatusBadge status={payment.status === "created" ? "pending" : payment.status} />
                </li>
              ))}
            </ul>
          )}
          {(adjustments.data ?? []).length > 0 ? (
            <div className="mt-4 space-y-1 text-sm">
              <h3 className="font-medium">Adjustments</h3>
              <ul className="list-disc pl-5">
                {(adjustments.data ?? []).map((adjustment) => (
                  <li key={adjustment.id}>
                    {adjustment.kind.replaceAll("_", " ")} · {formatMoney(adjustment.amount_minor, invoice.currency)} ·{" "}
                    {dateTime.format(new Date(adjustment.occurred_at))}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {canManage && payable ? (
        <Card>
          <CardHeader>
            <CardTitle>Record a manual payment</CardTitle>
            <CardDescription>
              For approved reconciliation such as a bank transfer. It is marked as a manual override and audited with your
              reason.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={recordManualPayment}
              submitLabel="Record payment"
              confirmMessage="Record this payment as received? It updates the balance and may make the client eligible for activation."
            >
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="manual-amount">Amount ({invoice.currency})</Label>
                  <Input id="manual-amount" name="amount" inputMode="decimal" defaultValue={minorToMajorString(invoice.balance_minor)} required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="manual-reference">Bank or receipt reference</Label>
                  <Input id="manual-reference" name="reference" required minLength={3} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="manual-reason">Reason</Label>
                <Textarea id="manual-reason" name="reason" rows={2} required minLength={3} />
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      {canManage && voidable ? (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">Void invoice</summary>
          <ActionForm action={voidInvoice} submitLabel="Void" variant="destructive" confirmMessage="Void this invoice?" className="mt-3">
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <div className="space-y-1">
              <Label htmlFor="void-reason">Reason (audited)</Label>
              <Textarea id="void-reason" name="reason" rows={2} required />
            </div>
          </ActionForm>
        </details>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Provider events</CardTitle>
        </CardHeader>
        <CardContent>
          {(events.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {(events.data ?? []).map((event) => (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 border-l-2 pl-3">
                  <span>
                    {event.provider} · {event.event_type}
                    {event.error_code ? <span className="text-muted-foreground"> · {event.error_code}</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={event.processing_status} />
                    <span className="text-xs text-muted-foreground">{dateTime.format(new Date(event.received_at))}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
