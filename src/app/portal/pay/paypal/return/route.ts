import { NextResponse } from "next/server";

import { getSessionUser } from "@/server/auth/session";
import { capturePayPalReturn, getPaymentStatus } from "@/server/billing";
import { handleRoute } from "@/server/http/route";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * PayPal sends the buyer back here after approval (?token=<order id>). The
 * server captures the order with its own credentials; the invoice page then
 * shows whatever the verified ledger says.
 */
export const GET = handleRoute(async ({ request, correlationId }) => {
  const url = request.nextUrl;
  const paymentId = url.searchParams.get("payment") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!(await getSessionUser())) {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, url));
  }
  if (!UUID.test(paymentId)) return NextResponse.redirect(new URL("/portal", url));

  if (url.searchParams.get("cancelled") === "1") {
    const status = await getPaymentStatus(paymentId);
    return NextResponse.redirect(new URL(`/portal/invoices/${status.invoice_id}?cancelled=1`, url));
  }
  const status = await capturePayPalReturn(paymentId, token, correlationId);
  return NextResponse.redirect(new URL(`/portal/invoices/${status.invoice_id}?payment=${paymentId}`, url));
});
