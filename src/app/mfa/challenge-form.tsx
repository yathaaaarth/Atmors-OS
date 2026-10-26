"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Result = { ok: true; data: null } | { ok: false; error: { message: string } } | null;

export function MfaChallengeForm({
  factorId,
  next,
  verify,
}: {
  factorId: string;
  next: string;
  verify: (state: Result, formData: FormData) => Promise<Result>;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(verify, null);
  useEffect(() => {
    if (state?.ok) router.replace(next);
  }, [state, next, router]);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="factorId" value={factorId} />
      <div className="space-y-1">
        <Label htmlFor="mfa-code">Code</Label>
        <Input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus className="w-32" />
      </div>
      <Button type="submit" disabled={pending || Boolean(state?.ok)}>
        {pending ? "Checking…" : "Continue"}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
