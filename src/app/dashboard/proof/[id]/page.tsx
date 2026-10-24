import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge, statusLabel } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APPROVER_TRANSITIONS, PROOF_TRANSITIONS, type ProofFormInput } from "@/modules/proof/schema";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import { transitionProofAsset } from "../actions";
import { ProofForm } from "../proof-form";

export const metadata: Metadata = { title: "Proof" };

export default async function ProofPage(props: PageProps<"/dashboard/proof/[id]">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/proof/${id}`, "proof.read");
  if (!access.allowed) return <AccessDenied />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: asset, error } = await supabase.from("proof_assets").select("*").eq("id", id).maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!asset) notFound();

  const canManage = can(access.context, "proof.manage");
  const canApprove = can(access.context, "proof.approve");
  const transitions = (PROOF_TRANSITIONS[asset.publication_status] ?? []).filter((to) =>
    APPROVER_TRANSITIONS.has(to) ? canApprove : canManage,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <Link href="/dashboard/proof" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Proof library
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{asset.title}</h1>
          <StatusBadge status={asset.publication_status} />
        </div>
        {asset.withdrawn_reason ? (
          <p className="text-sm text-muted-foreground">Withdrawn: {asset.withdrawn_reason}</p>
        ) : null}
      </header>

      {transitions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Publication</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-6">
            {transitions.map((to) => (
              <ActionForm
                key={to}
                action={transitionProofAsset}
                submitLabel={`Mark ${statusLabel(to).toLowerCase()}`}
                variant={to === "withdrawn" || to === "rejected" ? "destructive" : "outline"}
                confirmMessage={
                  to === "withdrawn" ? "Withdraw this proof? It disappears from every proposal view immediately." : undefined
                }
              >
                <input type="hidden" name="id" value={asset.id} />
                <input type="hidden" name="to" value={to} />
                {to === "withdrawn" || to === "rejected" ? (
                  <div className="space-y-1">
                    <Label htmlFor={`reason-${to}`}>Reason</Label>
                    <Input id={`reason-${to}`} name="reason" required minLength={3} />
                  </div>
                ) : null}
              </ActionForm>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{canManage ? "Edit" : "Details"}</CardTitle>
        </CardHeader>
        <CardContent>
          {canManage ? (
            <ProofForm
              id={asset.id}
              defaults={{
                kind: asset.kind,
                title: asset.title,
                quote: asset.quote ?? "",
                author_name: asset.author_name ?? "",
                author_role: asset.author_role ?? "",
                company_name: asset.company_name ?? "",
                narrative: asset.narrative ?? "",
                metrics: (asset.metrics ?? []) as ProofFormInput["metrics"],
                audience_tags: asset.audience_tags.join(", "),
                source_evidence_ref: asset.source_evidence_ref ?? "",
                permission_evidence_ref: asset.permission_evidence_ref ?? "",
                permission_expires_on: asset.permission_expires_on ?? "",
              }}
            />
          ) : (
            <div className="space-y-2 text-sm">
              {asset.quote ? <blockquote className="border-l-2 pl-3 italic">“{asset.quote}”</blockquote> : null}
              {asset.narrative ? <p className="whitespace-pre-line">{asset.narrative}</p> : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
