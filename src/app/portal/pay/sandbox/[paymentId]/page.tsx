import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAwaitingConfirmation } from "@/modules/billing/schema";
import { formatMoney } from "@/modules/proposals/money";
import { getSessionUser } from "@/server/auth/session";
import { getPaymentStatus } from "@/server/billing";
import { AppError } from "@/server/errors";
import { sandboxProvidersEnabled } from "@/server/integrations/config";

import { sandboxCheckout } from "../../../invoices/actions";

export const metadata: Metadata = { title: "Test checkout" };

/**
 * Development stand-in for a provider's hosted checkout. Each outcome is
 * delivered as a signed webhook through the real ingest path, so the portal
 * behaves exactly as it will with Razorpay. Not available in production.
 */
export default async function SandboxCheckoutPage(props: PageProps<"/portal/pay/sandbox/[paymentId]">) {
  if (!sandboxProvidersEnabled()) notFound();
  const { paymentId } = await props.params;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/portal/pay/sandbox/${paymentId}`);
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) notFound();

  let payment;
  try {
    payment = await getPaymentStatus(paymentId);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  if (payment.provider !== "sandbox") notFound();
  const hidden = <input type="hidden" name="paymentId" value={payment.payment_id} />;

  return (
    <div className="space-y-6">
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>
            <h1 className="font-heading text-xl font-semibold">Test checkout</h1>
          </CardTitle>
          <CardDescription>
            Sandbox provider: no real money moves. Paying {formatMoney(payment.amount_minor, payment.currency)} towards invoice{" "}
            {payment.invoice_number}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isAwaitingConfirmation(payment.status) ? (
            <div className="flex flex-wrap gap-3">
              <ActionForm action={sandboxCheckout} submitLabel="Pay successfully">
                {hidden}
                <input type="hidden" name="outcome" value="success" />
              </ActionForm>
              <ActionForm action={sandboxCheckout} submitLabel="Decline the payment" variant="outline">
                {hidden}
                <input type="hidden" name="outcome" value="failure" />
              </ActionForm>
              <ActionForm action={sandboxCheckout} submitLabel="Pay, but delay the confirmation" variant="outline">
                {hidden}
                <input type="hidden" name="outcome" value="delayed" />
              </ActionForm>
            </div>
          ) : (
            <p className="text-sm">This payment is already {payment.status}.</p>
          )}
          <Link href={`/portal/invoices/${payment.invoice_id}?payment=${payment.payment_id}`} className="text-sm underline underline-offset-4">
            Back to the invoice
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
