"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CONTACT_CHANNELS,
  prospectFormSchema,
  type ProspectFormInput,
  type ProspectFormValues,
} from "@/modules/crm/schema";

import { createProspect, updateProspect } from "./actions";

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

export function ProspectForm({
  prospectId,
  defaults,
  owners,
}: {
  prospectId?: string;
  defaults?: Partial<ProspectFormInput>;
  /** Present only when the user may assign owners. */
  owners?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProspectFormInput, unknown, ProspectFormValues>({
    resolver: zodResolver(prospectFormSchema),
    defaultValues: { contact_channel: "email", ...defaults },
  });

  const onSubmit = handleSubmit(async (_values, event) => {
    setFormError(null);
    setSaved(false);
    // Send the raw input; the server parses it again authoritatively.
    const raw = Object.fromEntries(new FormData(event?.target as HTMLFormElement)) as ProspectFormInput;
    const result = prospectId ? await updateProspect(prospectId, raw) : await createProspect(raw);
    if (result.ok) {
      if (prospectId) {
        setSaved(true);
        router.refresh();
      } else {
        router.push(`/dashboard/prospects/${result.data.id}`);
      }
      return;
    }
    for (const [field, messages] of Object.entries(result.error.field_errors ?? {})) {
      setError(field as keyof ProspectFormInput, { message: messages[0] });
    }
    setFormError(result.error.message);
  });

  const field = (name: keyof ProspectFormInput, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`prospect-${name}`}>{label}</Label>
      <Input
        id={`prospect-${name}`}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `prospect-${name}-error` : undefined}
        {...props}
        {...register(name)}
      />
      {errors[name] ? (
        <p id={`prospect-${name}-error`} role="alert" className="text-sm text-destructive">
          {errors[name]?.message}
        </p>
      ) : null}
    </div>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      {field("name", "Name")}
      {field("company", "Company")}
      {field("email", "Email", { type: "email", autoComplete: "off" })}
      <div className="space-y-1">
        <Label htmlFor="prospect-contact_channel">Preferred channel</Label>
        <select id="prospect-contact_channel" className={selectClass} {...register("contact_channel")}>
          {CONTACT_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {channel[0].toUpperCase() + channel.slice(1)}
            </option>
          ))}
        </select>
      </div>
      {field("contact_handle", "Phone / handle")}
      {field("source", "Lead source", { placeholder: "Referral, LinkedIn, event…" })}
      {field("target_service", "Service of interest")}
      {field("next_action_at", "Next follow-up (IST)", { type: "datetime-local" })}
      {owners ? (
        <div className="space-y-1">
          <Label htmlFor="prospect-owner_user_id">Owner</Label>
          <select id="prospect-owner_user_id" className={selectClass} {...register("owner_user_id")}>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="prospect-notes">Internal notes</Label>
        <Textarea id="prospect-notes" rows={4} {...register("notes")} />
        <p className="text-xs text-muted-foreground">Never shown to the prospect.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : prospectId ? "Save changes" : "Create prospect"}
        </Button>
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-success">
            Saved.
          </p>
        ) : null}
      </div>
    </form>
  );
}
