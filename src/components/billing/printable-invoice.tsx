import { formatMoney } from "@/modules/proposals/money";

export type PrintableInvoiceData = {
  invoiceNumber: string | null;
  label: string;
  currency: string;
  totalMinor: number;
  taxMinor: number;
  paidMinor: number;
  balanceMinor: number;
  issuedAt: string | null;
  dueAt: string | null;
  isExport: boolean;
  seller: { legalName: string; address: string | null; gstin: string | null; lutNumber: string | null; footer: string | null };
  buyer: { legalName: string | null; address: string | null; taxId: string | null; country: string | null };
  bankInstructions: string | null;
};

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" });

/**
 * An invoice laid out for printing or "Save as PDF". The same layout serves
 * clients and staff; both pass already-authorized data.
 */
export function PrintableInvoice({ invoice }: { invoice: PrintableInvoiceData }) {
  const taxable = invoice.totalMinor - invoice.taxMinor;
  return (
    <article className="mx-auto max-w-3xl space-y-8 rounded-lg border bg-card p-8 text-sm print:max-w-none print:border-0 print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="space-y-1">
          <p className="font-heading text-xl font-semibold">{invoice.seller.legalName}</p>
          {invoice.seller.address ? <p className="whitespace-pre-line text-muted-foreground">{invoice.seller.address}</p> : null}
          {invoice.seller.gstin ? <p>GSTIN {invoice.seller.gstin}</p> : null}
        </div>
        <div className="space-y-1 text-right">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {invoice.isExport ? "Tax invoice (export of services)" : "Tax invoice"}
          </h1>
          <p>No. {invoice.invoiceNumber ?? "pending"}</p>
          {invoice.issuedAt ? <p>Issued {dateFormat.format(new Date(invoice.issuedAt))}</p> : null}
          {invoice.dueAt ? <p>Due {dateFormat.format(new Date(invoice.dueAt))}</p> : null}
        </div>
      </header>

      <section aria-label="Billed to" className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Billed to</p>
        <p className="font-medium">{invoice.buyer.legalName}</p>
        {invoice.buyer.address ? <p className="whitespace-pre-line">{invoice.buyer.address}</p> : null}
        {invoice.buyer.country ? <p>Country: {invoice.buyer.country}</p> : null}
        {invoice.buyer.taxId ? <p>Tax ID: {invoice.buyer.taxId}</p> : null}
      </section>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 font-medium">Description</th>
            <th className="py-2 text-right font-medium">Amount ({invoice.currency})</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b">
            <td className="py-2">{invoice.label}</td>
            <td className="py-2 text-right tabular-nums">{formatMoney(taxable, invoice.currency)}</td>
          </tr>
          <tr>
            <td className="pt-2 text-muted-foreground">{invoice.isExport ? "IGST (zero-rated export)" : "GST"}</td>
            <td className="pt-2 text-right tabular-nums">{formatMoney(invoice.taxMinor, invoice.currency)}</td>
          </tr>
          <tr className="font-semibold">
            <td className="pt-2">Total</td>
            <td className="pt-2 text-right tabular-nums">{formatMoney(invoice.totalMinor, invoice.currency)}</td>
          </tr>
          {invoice.paidMinor > 0 ? (
            <tr>
              <td className="pt-1 text-muted-foreground">Paid</td>
              <td className="pt-1 text-right tabular-nums">−{formatMoney(invoice.paidMinor, invoice.currency)}</td>
            </tr>
          ) : null}
          <tr className="font-semibold">
            <td className="pt-1">Balance due</td>
            <td className="pt-1 text-right tabular-nums">{formatMoney(invoice.balanceMinor, invoice.currency)}</td>
          </tr>
        </tbody>
      </table>

      {invoice.isExport ? (
        <p className="rounded-md border p-3">
          Supply meant for export of services under Letter of Undertaking
          {invoice.seller.lutNumber ? ` ${invoice.seller.lutNumber}` : ""} without payment of integrated tax.
        </p>
      ) : null}

      {invoice.bankInstructions && invoice.balanceMinor > 0 ? (
        <section aria-label="Bank transfer" className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Pay by bank transfer</p>
          <p className="whitespace-pre-line">{invoice.bankInstructions}</p>
          <p className="text-muted-foreground">Reference: {invoice.invoiceNumber}</p>
        </section>
      ) : null}

      {invoice.seller.footer ? <footer className="border-t pt-4 text-xs text-muted-foreground">{invoice.seller.footer}</footer> : null}
    </article>
  );
}
