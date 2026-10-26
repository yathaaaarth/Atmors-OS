"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { PayResult } from "../actions";

type State = { ok: true; data: PayResult } | { ok: false; error: { message: string; correlation_id: string } } | null;

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  handler: () => void;
  modal: { ondismiss: () => void };
};
type RazorpayWindow = Window & { Razorpay?: new (options: RazorpayOptions) => { open(): void } };

const RAZORPAY_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpay(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as RazorpayWindow).Razorpay) return resolve();
    const script = document.createElement("script");
    script.src = RAZORPAY_SCRIPT;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the payment window."));
    document.body.appendChild(script);
  });
}

/**
 * Starts a payment and hands over to the provider's checkout. Whatever the
 * checkout reports, the return page waits for the server-verified event
 * before showing the payment as complete (AT-017).
 */
export function PayForm({
  action,
  invoiceId,
  idempotencyKey,
  balanceLabel,
  allowPartial,
  defaultAmount,
}: {
  action: (state: State, formData: FormData) => Promise<State>;
  invoiceId: string;
  idempotencyKey: string;
  balanceLabel: string;
  allowPartial: boolean;
  defaultAmount: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, null);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!state?.ok || handled.current === state.data.paymentId) return;
    handled.current = state.data.paymentId;
    const { checkout, returnUrl } = state.data;
    if (checkout.kind === "redirect") {
      router.push(checkout.url);
      return;
    }
    loadRazorpay()
      .then(() => {
        const Razorpay = (window as RazorpayWindow).Razorpay!;
        new Razorpay({
          key: checkout.keyId,
          order_id: checkout.orderId,
          amount: checkout.amountMinor,
          currency: checkout.currency,
          name: "Atmors",
          handler: () => router.push(returnUrl),
          modal: { ondismiss: () => router.push(returnUrl) },
        }).open();
      })
      .catch(() => router.push(returnUrl));
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {allowPartial ? (
        <div className="space-y-1">
          <Label htmlFor="pay-amount">Amount to pay now</Label>
          <Input id="pay-amount" name="amount" inputMode="decimal" defaultValue={defaultAmount} className="max-w-48" />
          <p className="text-xs text-muted-foreground">Part payments are allowed on this invoice, up to {balanceLabel}.</p>
        </div>
      ) : null}
      <Button type="submit" size="lg" disabled={pending || Boolean(state?.ok)}>
        {pending || state?.ok ? "Opening secure checkout…" : `Pay ${allowPartial ? "now" : balanceLabel}`}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error.message} <span className="text-xs text-muted-foreground">(ref {state.error.correlation_id.slice(0, 8)})</span>
        </p>
      ) : null}
    </form>
  );
}
