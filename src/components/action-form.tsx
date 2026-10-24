"use client";

import { useActionState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ActionState =
  | { ok: true; data?: unknown }
  | {
      ok: false;
      error: { message: string; field_errors?: Record<string, string[]>; correlation_id: string };
    }
  | null;

export type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * Small server-action form with pending state, error envelope display and an
 * optional confirmation for legally or financially meaningful actions.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  confirmMessage,
  successMessage,
  variant = "default",
  className,
}: {
  action: FormAction;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  confirmMessage?: string;
  successMessage?: string;
  variant?: "default" | "outline" | "secondary" | "destructive";
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const fieldErrors = state && !state.ok ? Object.entries(state.error.field_errors ?? {}) : [];

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) event.preventDefault();
      }}
      className={cn("space-y-3", className)}
    >
      {children}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? (pendingLabel ?? "Working…") : submitLabel}
      </Button>
      {state && !state.ok ? (
        <div role="alert" className="text-sm text-destructive">
          <p>
            {state.error.message}{" "}
            <span className="text-xs text-muted-foreground">(ref {state.error.correlation_id.slice(0, 8)})</span>
          </p>
          {fieldErrors.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {fieldErrors.map(([field, messages]) => (
                <li key={field}>
                  {field}: {messages.join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state?.ok && successMessage ? (
        <p role="status" className="text-sm text-success">
          {successMessage}
        </p>
      ) : null}
    </form>
  );
}
