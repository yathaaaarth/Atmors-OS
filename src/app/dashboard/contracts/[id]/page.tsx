import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { activationPolicySchema, describeBlockingReason, describeDue } from "@/modules/contracts/schema";
import { formatMoney } from "@/modules/proposals/money";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { envelopeProviderId } from "@/server/integrations/esign/registry";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import {
  amendContract,
  countersignContract,
  evaluateActivation,
  issueInvoice,
  recordActivationReview,
  sendContract,
  transitionContract,
} from "../actions";

export const metadata: Metadata = { title: "Agreement" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function ContractPage(props: PageProps<"/dashboard/contracts/[id]">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/contracts/${id}`, "contracts.read");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: contract, error } = await supabase
    .from("contracts")
    .select("*, prospects(id, name, company), contract_templates(name, version, jurisdiction_review_status)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!contract) notFound();

  const [signers, items, invoices, events, evaluations, amendments] = await Promise.all([
    supabase.from("contract_signers").select("*").eq("contract_id", id).order("position"),
    supabase.from("payment_schedule_items").select("*").eq("contract_id", id).order("position"),
    can(context, "finance.read")
      ? supabase.from("invoices").select("id, schedule_item_id, invoice_number, status, balance_minor, due_at").eq("contract_id", id)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("signature_events")
      .select("id, event_type, processing_status, error_code, signature_verified, received_at")
      .eq("contract_id", id)
      .order("received_at", { ascending: false })
      .limit(30),
    supabase.from("activation_evaluations").select("*").eq("contract_id", id).order("evaluated_at", { ascending: false }).limit(5),
    supabase.from("contracts").select("id, title, status, created_at").eq("supersedes_contract_id", id).order("created_at"),
  ]);
  for (const result of [signers, items, invoices, events, evaluations, amendments]) {
    if (result.error) throw fromPostgrestError(result.error);
  }

  const canManage = can(context, "contracts.manage");
  const isCountersigner = contract.countersigner_user_id === context.userId;
  const policy = contract.activation_policy ? activationPolicySchema.safeParse(contract.activation_policy).data : null;
  const itemLabels = (items.data ?? []).map((item) => item.label);
  const latest = evaluations.data?.[0];
  const providerReady = Boolean(envelopeProviderId());
  const open = ["draft", "ready_to_send", "sent", "viewed", "partially_signed"].includes(contract.status);
  const invoiceByItem = new Map((invoices.data ?? []).filter((invoice) => invoice.status !== "voided").map((invoice) => [invoice.schedule_item_id, invoice]));
  const hidden = <input type="hidden" name="contractId" value={contract.id} />;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link href={`/dashboard/proposals/${contract.proposal_id}`} className="text-sm text-muted-foreground underline underline-offset-4">
          ← Proposal
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{contract.title}</h1>
          <StatusBadge status={contract.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {contract.client_legal_name} · {formatMoney(contract.total_minor, contract.currency)} · document{" "}
          <code className="text-xs">{contract.checksum.slice(0, 16)}</code> · template {contract.contract_templates?.name} v
          {contract.template_version}
        </p>
        {contract.supersedes_contract_id ? (
          <p className="text-sm">
            Amends{" "}
            <Link href={`/dashboard/contracts/${contract.supersedes_contract_id}`} className="underline underline-offset-4">
              the executed agreement
            </Link>
            . Reason: {contract.amendment_reason}
          </p>
        ) : null}
      </header>

      {contract.contract_templates?.jurisdiction_review_status !== "approved" ? (
        <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          This template has not been approved by a qualified Indian legal professional. Treat agreements from it as drafts
          until it is (PRD §5.5, release gate).
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Next step</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {contract.status === "draft" && canManage ? (
            <ActionForm action={transitionContract} submitLabel="Mark ready to send" confirmMessage="Freeze this document? It can no longer be edited, only voided.">
              {hidden}
              <input type="hidden" name="action" value="mark_ready" />
              <p>Review the document below. Marking it ready freezes the text and its checksum.</p>
            </ActionForm>
          ) : null}
          {contract.status === "ready_to_send" && canManage ? (
            providerReady ? (
              <ActionForm action={sendContract} submitLabel="Send for signature" pendingLabel="Sending…">
                {hidden}
                <p>The client signs first, then {isCountersigner ? "you countersign" : "the named Atmors signer countersigns"}.</p>
              </ActionForm>
            ) : (
              <p>No e-signature provider is configured in this environment (see the provider register).</p>
            )
          ) : null}
          {["sent", "viewed"].includes(contract.status) ? <p>Waiting for the client to sign in their portal.</p> : null}
          {contract.status === "partially_signed" ? (
            isCountersigner && canManage ? (
              <ActionForm
                action={countersignContract}
                submitLabel="Countersign for Atmors"
                confirmMessage="Countersign this agreement? This executes it and issues any invoices due on signing."
              >
                {hidden}
                <input type="hidden" name="checksum" value={contract.checksum} />
                <p>The client has signed. Your countersignature executes the agreement.</p>
              </ActionForm>
            ) : (
              <p>The client has signed. Waiting for the named Atmors signer to countersign.</p>
            )
          ) : null}
          {contract.status === "executed" ? (
            <p>
              Executed {contract.executed_at ? dateTime.format(new Date(contract.executed_at)) : ""}. The document and signature evidence
              are immutable; changes need an amendment.
            </p>
          ) : null}
          {["declined", "voided", "expired"].includes(contract.status) ? (
            <p>
              This agreement is {contract.status}.{contract.void_reason ? ` Reason: ${contract.void_reason}` : ""} Generate a new one from the
              proposal if needed.
            </p>
          ) : null}

          {open && canManage ? (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer font-medium">Void agreement</summary>
              <ActionForm action={transitionContract} submitLabel="Void" variant="destructive" confirmMessage="Void this agreement?" className="mt-3">
                {hidden}
                <input type="hidden" name="action" value="void" />
                <div className="space-y-1">
                  <Label htmlFor="void-reason">Reason (audited)</Label>
                  <Textarea id="void-reason" name="reason" rows={2} required />
                </div>
              </ActionForm>
            </details>
          ) : null}

          {contract.status === "executed" && canManage && (amendments.data ?? []).every((row) => ["executed", "voided", "declined"].includes(row.status)) ? (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer font-medium">Create an amendment</summary>
              <ActionForm action={amendContract} submitLabel="Create amendment draft" className="mt-3">
                {hidden}
                <div className="space-y-1">
                  <Label htmlFor="amend-reason">Reason</Label>
                  <Input id="amend-reason" name="reason" required minLength={3} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="amend-text">Amendment text (appended to the agreement)</Label>
                  <Textarea id="amend-text" name="amendmentText" rows={5} required minLength={10} />
                </div>
              </ActionForm>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Signers</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {(signers.data ?? []).map((signer) => (
                <li key={signer.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {signer.name} <span className="text-muted-foreground">({signer.role === "client" ? "client" : "Atmors"}, {signer.email})</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={signer.status === "signed" ? "executed" : signer.status} />
                    {signer.signed_at ? <span className="text-xs text-muted-foreground">{dateTime.format(new Date(signer.signed_at))}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {policy ? (
          <Card>
            <CardHeader>
              <CardTitle>Activation</CardTitle>
              <CardDescription>
                Policy v{contract.activation_policy_version}: {policy.required_contract_state === "executed" ? "executed agreement" : "no signature"}
                {policy.required_payment_items.length > 0
                  ? `, paid ${policy.required_payment_items.map((index) => itemLabels[index] ?? `#${index + 1}`).join(", ")}`
                  : ""}
                {policy.required_onboarding_state === "approved" ? ", approved onboarding" : ""}
                {policy.required_manual_review ? ", manual review" : ""}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="font-medium">{contract.activation_eligible ? "Eligible for activation" : "Not yet eligible"}</p>
              {latest && !latest.eligible ? (
                <ul className="list-disc pl-5">
                  {latest.blocking_reasons.map((reason) => (
                    <li key={reason}>{describeBlockingReason(reason, itemLabels)}</li>
                  ))}
                </ul>
              ) : null}
              {latest ? (
                <p className="text-xs text-muted-foreground">
                  Last evaluated {dateTime.format(new Date(latest.evaluated_at))} ({latest.source})
                </p>
              ) : null}
              <ActionForm action={evaluateActivation} submitLabel="Re-evaluate" variant="outline">
                {hidden}
              </ActionForm>
              {policy.required_manual_review && !contract.activation_reviewed_at ? (
                <ActionForm action={recordActivationReview} submitLabel="Record manual review" variant="outline">
                  {hidden}
                  <div className="space-y-1">
                    <Label htmlFor="review-note">Review note</Label>
                    <Input id="review-note" name="note" required minLength={3} />
                  </div>
                </ActionForm>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {(items.data ?? []).length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Payment schedule</CardTitle>
            <CardDescription>Materialized from the accepted version when this agreement was generated.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {(items.data ?? []).map((item) => {
                const invoice = invoiceByItem.get(item.id);
                return (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <span>
                      <span className="font-medium">{item.label}</span>
                      <span className="block text-muted-foreground">
                        {describeDue(item as Parameters<typeof describeDue>[0])}
                        {item.activation_relevant ? " · required for activation" : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-3">
                      <span className="tabular-nums">{formatMoney(item.amount_minor, item.currency)}</span>
                      {invoice ? (
                        <Link href={`/dashboard/billing/invoices/${invoice.id}`} className="underline underline-offset-4">
                          {invoice.invoice_number}
                        </Link>
                      ) : null}
                      <StatusBadge status={invoice?.status ?? item.status} />
                    </span>
                    {item.status === "scheduled" && contract.status === "executed" && can(context, "billing.manage") ? (
                      <ActionForm action={issueInvoice} submitLabel="Issue invoice" variant="outline" className="flex w-full flex-wrap items-end gap-3 space-y-0">
                        {hidden}
                        <input type="hidden" name="itemId" value={item.id} />
                        <div className="space-y-1">
                          <Label htmlFor={`due-${item.id}`}>Due in (days)</Label>
                          <Input id={`due-${item.id}`} name="dueInDays" type="number" min={0} max={90} defaultValue={7} className="w-24" />
                        </div>
                        <label className="flex items-center gap-2 pb-2">
                          <input type="checkbox" name="allowPartial" /> Allow part payments
                        </label>
                      </ActionForm>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Document snapshot</CardTitle>
          <CardDescription>
            Exactly what the client sees and signs. SHA-256 <code className="break-all text-xs">{contract.checksum}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 font-sans text-sm">{contract.rendered_document}</pre>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Signature events</CardTitle>
            <CardDescription>Provider callbacks as received; unverified ones are quarantined.</CardDescription>
          </CardHeader>
          <CardContent>
            {(events.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {(events.data ?? []).map((event) => (
                  <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 border-l-2 pl-3">
                    <span>
                      {event.event_type}
                      {event.error_code ? <span className="text-muted-foreground"> · {event.error_code}</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={event.processing_status} />
                      <span className="text-xs text-muted-foreground">{dateTime.format(new Date(event.received_at))}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        {(amendments.data ?? []).length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Amendments</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {(amendments.data ?? []).map((amendment) => (
                  <li key={amendment.id} className="flex items-center justify-between gap-2">
                    <Link href={`/dashboard/contracts/${amendment.id}`} className="underline underline-offset-4">
                      {amendment.title}
                    </Link>
                    <StatusBadge status={amendment.status} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
