"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { beginInvitationSignIn, requestInvitationHelp } from "./actions";

type Result =
  | { ok: true; data: { sentTo?: string } | null }
  | { ok: false; error: { message: string; correlation_id: string } }
  | null;

export function VerifyToContinue({ token, maskedEmail }: { token: string; maskedEmail: string | null }) {
  const [state, action, pending] = useActionState(
    beginInvitationSignIn as (state: Result, formData: FormData) => Promise<Result>,
    null,
  );

  if (state?.ok && state.data?.sentTo) {
    return (
      <div role="status" className="space-y-1 text-sm">
        <p className="font-medium">Check your inbox</p>
        <p className="text-muted-foreground">
          We sent a secure sign-in link to {state.data.sentTo}. Open it in this browser to continue. Your place here is
          saved.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-muted-foreground">
        To accept or respond, confirm it&apos;s you. We&apos;ll email a single-use link to{" "}
        <span className="font-medium text-foreground">{maskedEmail ?? "the invited address"}</span>.
      </p>
      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={pending}>
        {pending ? "Sending…" : "Email me a secure link"}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}

const HELP_COPY = {
  new_link: { button: "Request a new link", done: "Thanks. Atmors will send you a fresh link shortly." },
  question: { button: "Send question", done: "Thanks. Your question has been passed to your Atmors contact." },
  changes: { button: "Request changes", done: "Thanks. Your Atmors contact will follow up about the changes." },
  call: { button: "Request a call", done: "Thanks. Your Atmors contact will reach out to schedule a call." },
} as const;

export function HelpRequest({
  token,
  kind,
  label,
  withMessage = true,
}: {
  token: string;
  kind: keyof typeof HELP_COPY;
  label?: string;
  withMessage?: boolean;
}) {
  const [state, action, pending] = useActionState(
    requestInvitationHelp as (state: Result, formData: FormData) => Promise<Result>,
    null,
  );
  if (state?.ok) {
    return (
      <p role="status" className="text-sm text-success">
        {HELP_COPY[kind].done}
      </p>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="kind" value={kind} />
      {withMessage ? (
        <div className="space-y-1">
          <Label htmlFor={`help-${kind}`}>{label ?? "Message"}</Label>
          <Textarea id={`help-${kind}`} name="message" rows={3} maxLength={2000} />
        </div>
      ) : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Sending…" : HELP_COPY[kind].button}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
