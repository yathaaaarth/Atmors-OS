import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { clientContractSchema, describeDue } from "@/modules/contracts/schema";
import { formatMoney } from "@/modules/proposals/money";
import { getSessionUser } from "@/server/auth/session";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { signContract } from "../actions";

export const metadata: Metadata = { title: "Agreement" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function PortalContractPage(props: PageProps<"/portal/contracts/[id]">) {
  const { id } = await props.params;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/portal/contracts/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_contract_view", { p_contract_id: id });
  if (error) {
    // Same response for missing and not-yours (AT-024).
    if (fromPostgrestError(error).code === "NOT_FOUND") notFound();
    throw fromPostgrestError(error);
  }
  const contract = clientContractSchema.parse(data);
  const clientSigner = contract.signers.find((signer) => signer.role === "client");

  return (
    <div className="space-y-6">
      <Link href="/portal" className="text-sm text-muted-foreground underline underline-offset-4">
        ← Your portal
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{contract.title}</h1>
          <StatusBadge status={contract.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {contract.client_legal_name} · {formatMoney(contract.total_minor, contract.currency)}
          {contract.is_amendment ? " · amendment" : ""}
        </p>
      </header>

      {contract.status === "executed" ? (
        <Card role="status">
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Signed by everyone</h2>
            </CardTitle>
            <CardDescription>
              Executed {contract.executed_at ? dateTime.format(new Date(contract.executed_at)) : ""}. Any invoice due on signing is
              now in your portal.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {contract.status === "partially_signed" ? (
        <p role="status" className="rounded-lg border p-4 text-sm">
          You&apos;ve signed. Atmors will countersign next, and you&apos;ll see the executed agreement here.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-heading text-lg font-semibold">Agreement</h2>
          </CardTitle>
          <CardDescription>
            Document reference <code className="break-all text-xs">{contract.checksum.slice(0, 16)}</code>. The text below is fixed;
            any change would create a new document.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 font-sans text-sm leading-relaxed">
            {contract.rendered_document}
          </pre>
        </CardContent>
      </Card>

      {contract.schedule.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Payment schedule</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {contract.schedule.map((line, index) => (
                <li key={`${line.label}-${index}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {line.label}
                    <span className="block text-muted-foreground">{describeDue(line)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{formatMoney(line.amount_minor, line.currency)}</span>
                    <StatusBadge status={line.status} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {contract.can_sign ? (
        <Card className="border-brand/40">
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Sign this agreement</h2>
            </CardTitle>
            <CardDescription>
              You&apos;re signing as {clientSigner?.name} on behalf of {contract.client_legal_name}. Your signature is recorded
              against this exact document.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={signContract}
              submitLabel="Sign agreement"
              pendingLabel="Recording signature…"
              confirmMessage="Sign this agreement? This is a legally meaningful action."
              successMessage="Signed. Thank you!"
            >
              <input type="hidden" name="contractId" value={contract.id} />
              <input type="hidden" name="checksum" value={contract.checksum} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
                <span>
                  I have read this agreement, I am authorised to sign it for {contract.client_legal_name}, and I agree to its terms.
                </span>
              </label>
            </ActionForm>
          </CardContent>
        </Card>
      ) : ["sent", "viewed"].includes(contract.status) && !contract.signer_matches_user ? (
        <p role="note" className="rounded-lg border p-4 text-sm">
          This agreement is to be signed by {clientSigner?.name}. Ask them to sign in to the portal with their own email.
        </p>
      ) : null}
    </div>
  );
}
