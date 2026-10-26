import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { newIdempotencyKey } from "@/lib/ids";
import { clientInvoiceSchema, isAwaitingConfirmation, type PaymentStatus } from "@/modules/billing/schema";
import { formatMoney, minorToMajorString } from "@/modules/proposals/money";
import { getSessionUser } from "@/server/auth/session";
import { getPaymentStatus } from "@/server/billing";
import { AppError, fromPostgrestError } from "@/server/errors";
import { checkoutOptions } from "@/server/integrations/payments/registry";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { ActionForm } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { payInvoice, reportTransfer } from "../actions";
import { PayForm } from "./pay-form";

export const metadata: Metadata = { title: "Invoice" };

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

async function paymentFromQuery(value: unknown): Promise<PaymentStatus | null> {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) return null;
  try {
    return await getPaymentStatus(value);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

function PaymentOutcome({ payment }: { payment: PaymentStatus }) {
  if (isAwaitingConfirmation(payment.status)) {
    return (
      <Card role="status" aria-live="polite">
        <CardHeader>
          <CardTitle>
            <h2 className="font-heading text-lg font-semibold">Confirming your payment</h2>
          </CardTitle>
          <CardDescription>
            We&apos;re waiting for confirmation from the payment provider. This page updates by itself; you can also close it
            and check back later. Please don&apos;t pay again in the meantime.
          </CardDescription>
        </CardHeader>
        {payment.provider === "sandbox" ? (
          <CardContent>
            <Link href={`/portal/pay/sandbox/${payment.payment_id}`} className="text-sm underline underline-offset-4">
              Open the test checkout
            </Link>
          </CardContent>
        ) : null}
        <AutoRefresh />
      </Card>
    );
  }
  if (payment.status === "succeeded") {
    return (
      <p role="status" className="rounded-lg border border-brand/40 p-4 text-sm">
        Payment of {formatMoney(payment.amount_minor, payment.currency)} confirmed. Thank you!
      </p>
    );
  }
  if (payment.status === "failed" || payment.status === "cancelled") {
    return (
      <p role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm">
        That payment didn&apos;t go through, so nothing was charged for it. You can try again below.
      </p>
    );
  }
  return null;
}

export default async function PortalInvoicePage(props: PageProps<"/portal/invoices/[id]">) {
  const { id } = await props.params;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/portal/invoices/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_invoice_view", { p_invoice_id: id });
  if (error) {
    if (fromPostgrestError(error).code === "NOT_FOUND") notFound();
    throw fromPostgrestError(error);
  }
  const invoice = clientInvoiceSchema.parse(data);
  const params = await props.searchParams;
  const payment = await paymentFromQuery(params.payment);
  const awaiting = payment ? isAwaitingConfirmation(payment.status) : false;
  const options = checkoutOptions(invoice.currency);

  return (
    <div className="space-y-6">
      <Link href="/portal" className="text-sm text-muted-foreground underline underline-offset-4">
        ← Your portal
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Invoice {invoice.invoice_number}</h1>
          <StatusBadge status={invoice.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {invoice.label} ·{" "}
          <Link href={`/portal/invoices/${invoice.id}/print`} className="underline underline-offset-4">
            Printable invoice
          </Link>
        </p>
      </header>

      {params.cancelled === "1" ? (
        <p role="status" className="rounded-lg border p-4 text-sm">
          You left the checkout before paying, so nothing was charged. Choose a payment method below to try again.
        </p>
      ) : null}

      {payment ? <PaymentOutcome payment={payment} /> : null}

      <Card>
        <CardContent className="grid gap-4 pt-6 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">Total</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(invoice.total_minor, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Paid</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(invoice.paid_minor, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Balance due</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(invoice.balance_minor, invoice.currency)}</p>
            {invoice.due_at ? <p className="text-xs text-muted-foreground">by {dateFormat.format(new Date(invoice.due_at))}</p> : null}
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            {invoice.export
              ? "Export of services: invoiced without Indian GST. Any taxes in your country are your responsibility."
              : "Amounts include applicable taxes as set out in your agreement."}
          </p>
        </CardContent>
      </Card>

      {invoice.status === "disputed" ? (
        <p role="note" className="rounded-lg border p-4 text-sm">
          A payment on this invoice is under review with the payment provider. Atmors will be in touch.
        </p>
      ) : null}

      {invoice.can_pay && !awaiting ? (
        <Card className="border-brand/40">
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Pay securely</h2>
            </CardTitle>
            <CardDescription>
              You&apos;ll be taken to the payment provider. Card and bank details never pass through Atmors. You pay in{" "}
              {invoice.currency}; your bank or card may convert it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {options.length > 0 ? (
              <PayForm
                action={payInvoice}
                invoiceId={invoice.id}
                idempotencyKey={newIdempotencyKey()}
                balanceLabel={formatMoney(invoice.balance_minor, invoice.currency)}
                allowPartial={invoice.allow_partial}
                defaultAmount={minorToMajorString(invoice.balance_minor)}
                options={options}
              />
            ) : !invoice.bank_instructions ? (
              <p className="text-sm">Online payment isn&apos;t available right now. Reply to your Atmors email for bank transfer details.</p>
            ) : null}

            {invoice.bank_instructions ? (
              <section aria-labelledby="wire-heading" className="space-y-3 rounded-md border p-4">
                <h3 id="wire-heading" className="font-medium">
                  Pay by bank transfer {invoice.export ? "(international wire)" : ""}
                </h3>
                <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 font-sans text-sm">{invoice.bank_instructions}</pre>
                <p className="text-xs text-muted-foreground">
                  Put invoice number {invoice.invoice_number} in the payment reference. The invoice shows as paid once the money arrives
                  and finance confirms it, usually 1 to 3 working days.
                </p>
                {invoice.transfer_reported_at ? (
                  <p role="status" className="text-sm">
                    Thanks, you told us about a transfer on {dateFormat.format(new Date(invoice.transfer_reported_at))}. Finance will
                    confirm it.
                  </p>
                ) : null}
                <ActionForm
                  action={reportTransfer}
                  submitLabel="I've sent the transfer"
                  variant="outline"
                  successMessage="Thanks. Finance will confirm the payment when it arrives."
                >
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <div className="space-y-1">
                    <Label htmlFor="transfer-reference">Bank reference (UTR, SWIFT reference or similar)</Label>
                    <Input id="transfer-reference" name="reference" required minLength={3} maxLength={200} className="max-w-md" />
                  </div>
                </ActionForm>
              </section>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {invoice.payments.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Payment history</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {invoice.payments.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="tabular-nums">{formatMoney(entry.amount_minor, invoice.currency)}</span>
                    {entry.manual ? " · recorded by Atmors" : ""}
                    {entry.refunded_minor > 0 ? ` · ${formatMoney(entry.refunded_minor, invoice.currency)} refunded` : ""}
                    <span className="block text-xs text-muted-foreground">{dateFormat.format(new Date(entry.created_at))}</span>
                  </span>
                  <StatusBadge status={entry.status === "created" ? "pending" : entry.status} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
