import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PrintButton } from "@/components/billing/print-button";
import { PrintableInvoice } from "@/components/billing/printable-invoice";
import { clientInvoiceSchema } from "@/modules/billing/schema";
import { getSessionUser } from "@/server/auth/session";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "Invoice" };

export default async function PortalPrintableInvoicePage(props: PageProps<"/portal/invoices/[id]/print">) {
  const { id } = await props.params;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/portal/invoices/${id}/print`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_invoice_view", { p_invoice_id: id });
  if (error) {
    if (fromPostgrestError(error).code === "NOT_FOUND") notFound();
    throw fromPostgrestError(error);
  }
  const invoice = clientInvoiceSchema.parse(data);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/portal/invoices/${id}`} className="text-sm text-muted-foreground underline underline-offset-4">
          ← Back to the invoice
        </Link>
        <PrintButton />
      </div>
      <PrintableInvoice
        invoice={{
          invoiceNumber: invoice.invoice_number,
          label: invoice.label,
          currency: invoice.currency,
          totalMinor: invoice.total_minor,
          taxMinor: invoice.tax_minor,
          paidMinor: invoice.paid_minor,
          balanceMinor: invoice.balance_minor,
          issuedAt: invoice.issued_at,
          dueAt: invoice.due_at,
          isExport: invoice.export,
          seller: {
            legalName: invoice.seller?.legal_name ?? "Atmors",
            address: invoice.seller?.address ?? null,
            gstin: invoice.seller?.gstin ?? null,
            lutNumber: invoice.seller?.lut_number ?? null,
            footer: invoice.seller?.footer ?? null,
          },
          buyer: {
            legalName: invoice.buyer?.legal_name ?? null,
            address: invoice.buyer?.address ?? null,
            taxId: invoice.buyer?.tax_id ?? null,
            country: invoice.buyer?.country ?? null,
          },
          bankInstructions: invoice.bank_instructions ?? null,
        }}
      />
    </div>
  );
}
