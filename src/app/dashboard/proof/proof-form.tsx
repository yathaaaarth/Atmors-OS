"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { proofFormSchema, type ProofFormInput } from "@/modules/proof/schema";

import { saveProofAsset } from "./actions";

type FormValues = Omit<ProofFormInput, "audience_tags"> & { audience_tags: string };

const selectClass = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm";

export function ProofForm({ id, defaults }: { id?: string; defaults?: Partial<FormValues> }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const { control, register, handleSubmit, formState } = useForm<FormValues>({
    defaultValues: { kind: "testimonial", metrics: [], audience_tags: "", ...defaults },
  });
  const metrics = useFieldArray({ control, name: "metrics" });
  const kind = useWatch({ control, name: "kind" });

  const onSubmit = handleSubmit(async (values) => {
    setSaved(false);
    const input = {
      ...values,
      // The type selector is disabled when editing, and disabled inputs submit no value.
      kind: values.kind ?? defaults?.kind ?? "testimonial",
      audience_tags: (values.audience_tags ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    const parsed = proofFormSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
      return;
    }
    setErrors([]);
    const result = await saveProofAsset(id ?? null, input);
    if (!result.ok) {
      setErrors([`${result.error.message} (ref ${result.error.correlation_id.slice(0, 8)})`]);
      return;
    }
    if (id) {
      setSaved(true);
      router.refresh();
    } else {
      router.push(`/dashboard/proof/${result.data.id}`);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor="proof-kind">Type</Label>
          <select id="proof-kind" className={selectClass} disabled={Boolean(id)} {...register("kind")}>
            <option value="testimonial">Testimonial</option>
            <option value="case_study">Case study</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="proof-title">Title</Label>
          <Input id="proof-title" {...register("title")} />
        </div>
      </div>
      {kind === "testimonial" ? (
        <div className="space-y-1">
          <Label htmlFor="proof-quote">Quote (exactly as approved by the client)</Label>
          <Textarea id="proof-quote" rows={3} {...register("quote")} />
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="proof-narrative">Narrative</Label>
          <Textarea id="proof-narrative" rows={6} {...register("narrative")} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="proof-author">Person</Label>
          <Input id="proof-author" {...register("author_name")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="proof-role">Role</Label>
          <Input id="proof-role" {...register("author_role")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="proof-company">Company</Label>
          <Input id="proof-company" {...register("company_name")} />
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Metrics</legend>
        <p className="text-xs text-muted-foreground">
          Every number needs its period and evidence, and must say whether it was measured or reported by the client.
        </p>
        {metrics.fields.map((field, index) => (
          <div key={field.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-5 sm:items-end">
            <div className="space-y-1">
              <Label htmlFor={`metric-${index}-value`}>Value</Label>
              <Input id={`metric-${index}-value`} placeholder="+40%" {...register(`metrics.${index}.value`)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`metric-${index}-label`}>Label</Label>
              <Input id={`metric-${index}-label`} placeholder="qualified leads" {...register(`metrics.${index}.label`)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`metric-${index}-kind`}>Kind</Label>
              <select id={`metric-${index}-kind`} className={selectClass} {...register(`metrics.${index}.kind`)}>
                <option value="measured">Measured</option>
                <option value="client_reported">Client-reported</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`metric-${index}-period`}>Period</Label>
              <Input id={`metric-${index}-period`} placeholder="Jan–Mar 2026" {...register(`metrics.${index}.period`)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`metric-${index}-evidence`}>Evidence</Label>
              <div className="flex gap-1">
                <Input id={`metric-${index}-evidence`} placeholder="Link or file ref" {...register(`metrics.${index}.evidence_ref`)} />
                <Button type="button" variant="ghost" onClick={() => metrics.remove(index)} aria-label={`Remove metric ${index + 1}`}>
                  ×
                </Button>
              </div>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => metrics.append({ label: "", value: "", kind: "measured", period: "", evidence_ref: "" })}
        >
          Add metric
        </Button>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="proof-source">Source evidence</Label>
          <Input id="proof-source" placeholder="Where this came from" {...register("source_evidence_ref")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="proof-permission">Permission record</Label>
          <Input id="proof-permission" placeholder="Signed release, email…" {...register("permission_evidence_ref")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="proof-expiry">Permission expires on</Label>
          <Input id="proof-expiry" type="date" {...register("permission_expires_on")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="proof-tags">Audience tags</Label>
          <Input id="proof-tags" placeholder="founders, saas" {...register("audience_tags")} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Editing approved or published proof sends it back to draft for re-approval.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? "Saving…" : id ? "Save changes" : "Create"}
        </Button>
        {saved ? (
          <p role="status" className="text-sm text-success">
            Saved.
          </p>
        ) : null}
      </div>
      {errors.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
