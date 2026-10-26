"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Err = { ok: false; error: { message: string; correlation_id: string } };
type StartResult = { ok: true; data: { sentTo: string; devCode?: string } } | Err;
type CompleteResult = { ok: true; data: { status: string; attemptsLeft?: number } } | Err | null;

/**
 * Built-in e-signature: email a one-time code to the named signer, then sign
 * with the code and a typed name. Evidence (time, verified email, document
 * checksum, device details) is recorded with the signature.
 */
export function InternalSignForm({
  contractId,
  checksum,
  signerName,
  onBehalfOf,
  requestCode,
  sign,
}: {
  contractId: string;
  checksum: string;
  signerName: string;
  onBehalfOf: string;
  requestCode: (formData: FormData) => Promise<StartResult>;
  sign: (state: CompleteResult, formData: FormData) => Promise<CompleteResult>;
}) {
  const router = useRouter();
  const [codeState, setCodeState] = useState<{ sentTo: string; devCode?: string } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [requesting, startRequest] = useTransition();
  const [state, formAction, pending] = useActionState(sign, null);
  const signed = state?.ok && state.data.status === "signed";

  useEffect(() => {
    if (signed) router.refresh();
  }, [signed, router]);

  if (signed) {
    return (
      <p role="status" className="text-sm font-medium text-success">
        Signed. Thank you!
      </p>
    );
  }

  function request() {
    setCodeError(null);
    startRequest(async () => {
      const form = new FormData();
      form.set("contractId", contractId);
      form.set("checksum", checksum);
      const result = await requestCode(form);
      if (result.ok) setCodeState(result.data);
      else setCodeError(result.error.message);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        To sign, we&apos;ll email a 6-digit code to confirm it&apos;s you, then you type your name. Your signature is recorded
        against this exact document.
      </p>
      {!codeState ? (
        <Button type="button" onClick={request} disabled={requesting}>
          {requesting ? "Sending code…" : "Email me a signing code"}
        </Button>
      ) : (
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="contractId" value={contractId} />
          <input type="hidden" name="checksum" value={checksum} />
          <p role="status" className="text-sm">
            We sent a code to {codeState.sentTo}. It expires in 10 minutes.{" "}
            <button type="button" onClick={request} className="underline underline-offset-4" disabled={requesting}>
              Send another
            </button>
          </p>
          {codeState.devCode ? (
            <p className="rounded border border-dashed p-2 text-xs">Development only (no email service configured): the code is {codeState.devCode}</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="sign-code">Code from the email</Label>
              <Input id="sign-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sign-name">Type your full name</Label>
              <Input id="sign-name" name="typedName" autoComplete="name" placeholder={signerName} required />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" value="yes" required className="mt-1" />
            <span>
              I agree to sign electronically. I have read this agreement, I am authorised to sign it for {onBehalfOf}, and typing my
              name is my signature.
            </span>
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? "Signing…" : "Sign agreement"}
          </Button>
          {state?.ok && state.data.status === "wrong_code" ? (
            <p role="alert" className="text-sm text-destructive">
              That code isn&apos;t right. {state.data.attemptsLeft ? `${state.data.attemptsLeft} attempts left.` : "Request a new code."}
            </p>
          ) : null}
          {state && !state.ok ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error.message}
            </p>
          ) : null}
        </form>
      )}
      {codeError ? (
        <p role="alert" className="text-sm text-destructive">
          {codeError}
        </p>
      ) : null}
    </div>
  );
}
