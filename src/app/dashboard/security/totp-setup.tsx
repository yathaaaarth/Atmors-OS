"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Result<T> = { ok: true; data: T } | { ok: false; error: { message: string } } | null;

export function TotpSetup({
  start,
  verify,
}: {
  start: () => Promise<Result<{ factorId: string; qrCode: string; secret: string }>>;
  verify: (state: Result<null>, formData: FormData) => Promise<Result<null>>;
}) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, startTransition] = useTransition();
  const [state, formAction, pending] = useActionState(verify, null);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  if (state?.ok) {
    return (
      <p role="status" className="text-sm text-success">
        Authenticator added. You&apos;ll be asked for a code when you sign in.
      </p>
    );
  }

  if (!enrollment) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          disabled={starting}
          onClick={() =>
            startTransition(async () => {
              const result = await start();
              if (result?.ok) setEnrollment(result.data);
              else setStartError(result && !result.ok ? result.error.message : "Couldn't start setup.");
            })
          }
        >
          {starting ? "Preparing…" : "Set up an authenticator app"}
        </Button>
        {startError ? (
          <p role="alert" className="text-sm text-destructive">
            {startError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="factorId" value={enrollment.factorId} />
      <p className="text-sm">Scan this code with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code.</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URI from Supabase */}
      <img src={enrollment.qrCode} alt="QR code for your authenticator app" width={180} height={180} className="rounded border bg-white p-2" />
      <p className="text-xs text-muted-foreground">
        Can&apos;t scan? Enter this key manually: <code className="break-all">{enrollment.secret}</code>
      </p>
      <div className="space-y-1">
        <Label htmlFor="totp-code">6-digit code</Label>
        <Input id="totp-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required className="w-32" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Verify and turn on"}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
