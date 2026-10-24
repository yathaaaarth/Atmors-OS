"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { requestSignInLink } from "./actions";
import { signInSchema, type SignInValues } from "./schema";

export function LoginForm({ next }: { next?: string }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", next },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const result = await requestSignInLink(values);
    if (result.ok) {
      setSentTo(values.email);
    } else {
      setFormError(result.error.field_errors?.email?.[0] ?? result.error.message);
    }
  });

  if (sentTo) {
    return (
      <div role="status" className="space-y-2 rounded-lg border bg-card p-4">
        <p className="font-medium">Check your inbox</p>
        <p className="text-sm text-muted-foreground">
          If <span className="font-medium text-foreground">{sentTo}</span> has access, a sign-in link is on its way.
          Open it in this browser. The link expires after one hour.
        </p>
        <Button variant="link" className="h-auto px-0" onClick={() => setSentTo(null)}>
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? "email-error" : undefined}
          {...register("email")}
        />
        {errors.email ? (
          <p id="email-error" role="alert" className="text-sm text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>
      <input type="hidden" {...register("next")} />
      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? "Sending link…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
