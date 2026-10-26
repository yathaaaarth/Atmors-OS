import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { PrintButton } from "@/components/billing/print-button";
import { PrintableInvoice } from "@/components/billing/printable-invoice";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../../../member-page";

export const metadata: Metadata = { title: "Invoice" };

export default async function DashboardPrintableInvoicePage(props: PageProps<"/dashboard/billing/invoices/[id]/print">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/billing/invoices/${id}/print`, "finance.read");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const [invoiceResult, settingsResult] = await Promise.all([
    supabase
      .from("invoices")
      .select("*, contracts(client_legal_name, client_address, client_tax_id, client_country)")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("billing_settings").select("*").eq("organization_id", context.organizationId).maybeSingle(),
  ]);
  if (invoiceResult.error) throw fromPostgrestError(invoiceResult.error);
  if (settingsResult.error) throw fromPostgrestError(settingsResult.error);
  const invoice = invoiceResult.data;
  if (!invoice) notFound();
  const settings = settingsResult.data;
  const contract = invoice.contracts;
  const isExport = (contract?.client_country ?? "IN") !== "IN";
  const taxMinor = Number((invoice.tax_snapshot as { tax_minor?: number } | null)?.tax_minor ?? 0);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/dashboard/billing/invoices/${id}`} className="text-sm text-muted-foreground underline underline-offset-4">
          ← Back to the invoice
        </Link>
        <PrintButton />
      </div>
      <p role="note" className="rounded-md border p-3 text-sm print:hidden">
        Tax amounts are proportional estimates from the accepted proposal and need accountant review before filing.
        {isExport && taxMinor > 0 ? " This export invoice carries tax: check whether it should be zero-rated under your LUT." : ""}
        {!settings?.gstin ? " Add your GSTIN and address under Billing, Invoice details." : ""}
      </p>
      <PrintableInvoice
        invoice={{
          invoiceNumber: invoice.invoice_number,
          label: invoice.label,
          currency: invoice.currency,
          totalMinor: invoice.total_minor,
          taxMinor,
          paidMinor: invoice.paid_minor,
          balanceMinor: invoice.balance_minor,
          issuedAt: invoice.issued_at,
          dueAt: invoice.due_at,
          isExport,
          seller: {
            legalName: settings?.legal_name ?? context.organizationName,
            address: settings?.address ?? null,
            gstin: settings?.gstin ?? null,
            lutNumber: isExport ? (settings?.lut_number ?? null) : null,
            footer: settings?.invoice_footer ?? null,
          },
          buyer: {
            legalName: contract?.client_legal_name ?? null,
            address: contract?.client_address ?? null,
            taxId: contract?.client_tax_id ?? null,
            country: contract?.client_country ?? null,
          },
          bankInstructions: ["issued", "partially_paid", "overdue"].includes(invoice.status) ? (settings?.bank_instructions ?? null) : null,
        }}
      />
    </div>
  );
}
