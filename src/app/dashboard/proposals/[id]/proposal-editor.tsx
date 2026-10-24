"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EMPTY_LINE, editorToDraftInput, type EditorValues } from "@/modules/proposals/editor-values";
import { computeTotals, CURRENCIES, formatMoney, validateSchedule } from "@/modules/proposals/money";
import { BILLING_TIMING_LABELS, BILLING_TIMINGS, SCHEDULE_DUE, SCHEDULE_DUE_LABELS } from "@/modules/proposals/schema";

import { saveProposalDraft } from "../actions";

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

export type ProofOption = { id: string; title: string; kind: string };

function TextSection({
  id,
  label,
  hint,
  rows = 4,
  register,
}: {
  id: string;
  label: string;
  hint?: string;
  rows?: number;
  register: ReturnType<typeof useForm<EditorValues>>["register"];
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`editor-${id}`}>{label}</Label>
      <Textarea id={`editor-${id}`} rows={rows} {...register(id as keyof EditorValues)} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ProposalEditor({
  proposalId,
  versionId,
  defaults,
  proofOptions,
}: {
  proposalId: string;
  versionId: string;
  defaults: EditorValues;
  proofOptions: ProofOption[];
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const { control, register, handleSubmit, formState } = useForm<EditorValues>({ defaultValues: defaults });
  const lineItems = useFieldArray({ control, name: "lineItems" });
  const schedule = useFieldArray({ control, name: "schedule" });
  const watched = useWatch({ control });

  // Live preview using the same arithmetic as the database.
  const preview = useMemo(() => {
    const conversion = editorToDraftInput(versionId, watched as EditorValues);
    if (!conversion.ok) return null;
    try {
      const totals = computeTotals(conversion.input.lineItems);
      return {
        totals,
        scheduleError: validateSchedule(conversion.input.paymentSchedule, totals.total_minor),
        needsApproval: totals.discount_minor > 0 || conversion.input.nonStandardTerms || conversion.input.marginException,
      };
    } catch {
      return null;
    }
  }, [watched, versionId]);

  const onSubmit = handleSubmit(async (values) => {
    setStatus(null);
    const conversion = editorToDraftInput(versionId, values);
    if (!conversion.ok) {
      setErrors(conversion.errors);
      return;
    }
    setErrors([]);
    const result = await saveProposalDraft(proposalId, conversion.input);
    if (result.ok) {
      setStatus(
        `Draft saved. Total ${formatMoney(result.data.total_minor, values.currency)}${
          result.data.requires_approval ? " — needs approval before sending." : "."
        }`,
      );
      router.refresh();
    } else {
      setErrors([
        `${result.error.message} (ref ${result.error.correlation_id.slice(0, 8)})`,
        ...Object.entries(result.error.field_errors ?? {}).map(([field, messages]) => `${field}: ${messages.join(", ")}`),
      ]);
    }
  });

  const currency = (watched.currency ?? defaults.currency) as string;
  const scheduleBasis = watched.scheduleBasis ?? defaults.scheduleBasis;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-8">
      <fieldset className="grid gap-4 sm:grid-cols-[1fr_8rem_10rem]">
        <legend className="sr-only">Basics</legend>
        <div className="space-y-1">
          <Label htmlFor="editor-title">Title</Label>
          <Input id="editor-title" {...register("title", { required: true })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="editor-currency">Currency</Label>
          <select id="editor-currency" className={selectClass} {...register("currency")}>
            {CURRENCIES.map((code) => (
              <option key={code}>{code}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="editor-valid-until">Valid until</Label>
          <Input id="editor-valid-until" type="date" {...register("validUntil")} />
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-heading text-lg font-semibold">Scope</legend>
        <TextSection id="summary" label="Summary" rows={3} register={register} />
        <TextSection id="scope" label="Scope of work" rows={5} register={register} />
        <TextSection id="deliverables" label="Deliverables" hint="One per line." register={register} />
        <TextSection id="timeline" label="Timeline" rows={3} register={register} />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextSection id="dependencies" label="What we need from the client" hint="One per line." register={register} />
          <TextSection id="assumptions" label="Assumptions" hint="One per line." register={register} />
          <TextSection id="exclusions" label="Not included" hint="One per line." register={register} />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-heading text-lg font-semibold">Pricing</legend>
        <ul className="space-y-3">
          {lineItems.fields.map((field, index) => (
            <li key={field.id} className="space-y-3 rounded-lg border p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1">
                  <Label htmlFor={`line-${index}-title`}>Line {index + 1}</Label>
                  <Input id={`line-${index}-title`} placeholder="Title" {...register(`lineItems.${index}.title`)} />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="self-end"
                  onClick={() => lineItems.remove(index)}
                  aria-label={`Remove line ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
              <Textarea
                rows={2}
                placeholder="Description (optional)"
                aria-label={`Line ${index + 1} description`}
                {...register(`lineItems.${index}.description`)}
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
                <div className="space-y-1">
                  <Label htmlFor={`line-${index}-qty`}>Qty</Label>
                  <Input id={`line-${index}-qty`} inputMode="decimal" {...register(`lineItems.${index}.quantity`)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`line-${index}-unit`}>Unit</Label>
                  <Input id={`line-${index}-unit`} placeholder="month" {...register(`lineItems.${index}.unit`)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`line-${index}-price`}>Unit price</Label>
                  <Input id={`line-${index}-price`} inputMode="decimal" {...register(`lineItems.${index}.unitAmount`)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`line-${index}-discount`}>Discount</Label>
                  <Input id={`line-${index}-discount`} inputMode="decimal" {...register(`lineItems.${index}.discount`)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`line-${index}-tax`}>Tax %</Label>
                  <Input id={`line-${index}-tax`} inputMode="decimal" {...register(`lineItems.${index}.taxPercent`)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`line-${index}-billing`}>Billing</Label>
                  <select id={`line-${index}-billing`} className={selectClass} {...register(`lineItems.${index}.billing_timing`)}>
                    {BILLING_TIMINGS.map((value) => (
                      <option key={value} value={value}>
                        {BILLING_TIMING_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <Button type="button" variant="outline" onClick={() => lineItems.append({ ...EMPTY_LINE })}>
          Add line
        </Button>
        <div aria-live="polite" className="rounded-lg bg-muted p-3 text-sm tabular-nums">
          {preview ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Subtotal</dt>
                <dd>{formatMoney(preview.totals.subtotal_minor, currency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Discount</dt>
                <dd>{formatMoney(preview.totals.discount_minor, currency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Tax</dt>
                <dd>{formatMoney(preview.totals.tax_minor, currency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Total</dt>
                <dd className="font-semibold">{formatMoney(preview.totals.total_minor, currency)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground">Totals appear once every line has valid numbers.</p>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-heading text-lg font-semibold">Payment schedule</legend>
        <p className="text-sm text-muted-foreground">
          Specific to this agreement. Percentages must total 100%; fixed amounts must equal the total.
        </p>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" value="percent" {...register("scheduleBasis")} /> Percentages
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" value="fixed" {...register("scheduleBasis")} /> Fixed amounts
          </label>
        </div>
        <ul className="space-y-3">
          {schedule.fields.map((field, index) => {
            const due = watched.schedule?.[index]?.due;
            return (
              <li key={field.id} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_7rem_10rem_10rem_auto] sm:items-end">
                <div className="space-y-1">
                  <Label htmlFor={`sched-${index}-label`}>Instalment</Label>
                  <Input id={`sched-${index}-label`} placeholder="Deposit" {...register(`schedule.${index}.label`)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`sched-${index}-value`}>{scheduleBasis === "percent" ? "%" : "Amount"}</Label>
                  <Input id={`sched-${index}-value`} inputMode="decimal" {...register(`schedule.${index}.value`)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`sched-${index}-due`}>Due</Label>
                  <select id={`sched-${index}-due`} className={selectClass} {...register(`schedule.${index}.due`)}>
                    {SCHEDULE_DUE.map((value) => (
                      <option key={value} value={value}>
                        {SCHEDULE_DUE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  {due === "on_date" ? (
                    <>
                      <Label htmlFor={`sched-${index}-date`}>Date</Label>
                      <Input id={`sched-${index}-date`} type="date" {...register(`schedule.${index}.due_date`)} />
                    </>
                  ) : due === "on_milestone" ? (
                    <>
                      <Label htmlFor={`sched-${index}-milestone`}>Milestone</Label>
                      <Input id={`sched-${index}-milestone`} {...register(`schedule.${index}.milestone`)} />
                    </>
                  ) : null}
                </div>
                <Button type="button" variant="ghost" onClick={() => schedule.remove(index)} aria-label={`Remove instalment ${index + 1}`}>
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant="outline"
          onClick={() => schedule.append({ label: "", value: "", due: "on_signing", due_date: "", milestone: "" })}
        >
          Add instalment
        </Button>
        {preview?.scheduleError ? <p className="text-sm text-warning">{preview.scheduleError}</p> : null}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-heading text-lg font-semibold">Terms and proof</legend>
        <TextSection id="terms" label="Terms" rows={6} register={register} />
        {proofOptions.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Attach approved proof</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {proofOptions.map((option) => (
                <li key={option.id}>
                  <label className="flex items-start gap-2 rounded-md border p-2 text-sm">
                    <input type="checkbox" value={option.id} {...register("proofIds")} className="mt-1" />
                    <span>
                      {option.title}
                      <span className="block text-xs text-muted-foreground">
                        {option.kind === "case_study" ? "Case study" : "Testimonial"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No approved proof is available to attach yet.</p>
        )}
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" {...register("nonStandardTerms")} /> Includes non-standard terms
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" {...register("marginException")} /> Margin exception
          </label>
          {preview?.needsApproval ? (
            <p className="text-warning">
              This version will need approval from someone with approval authority before it can be sent.
            </p>
          ) : null}
        </div>
      </fieldset>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t bg-background/95 py-3 backdrop-blur">
        <Button type="submit" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? "Saving…" : "Save draft"}
        </Button>
        {status ? (
          <p role="status" className="text-sm text-success">
            {status}
          </p>
        ) : null}
        {errors.length > 0 ? (
          <ul role="alert" className="w-full list-disc pl-5 text-sm text-destructive">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </form>
  );
}
