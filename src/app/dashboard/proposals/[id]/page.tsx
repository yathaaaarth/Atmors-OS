import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { ProposalDocument } from "@/components/proposal/proposal-document";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ClientProof } from "@/modules/proposals/client-view";
import { versionToEditorValues } from "@/modules/proposals/editor-values";
import { formatMoney, type ScheduleItem } from "@/modules/proposals/money";
import { todayIst, toClientVersion } from "@/modules/proposals/staff-preview";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import { createRevision, reviewVersion, sendVersion, submitVersion, withdrawProposal } from "../actions";

import { GenerateContract } from "./generate-contract";
import { ProposalEditor } from "./proposal-editor";

export const metadata: Metadata = { title: "Proposal" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const LINE_COLUMNS =
  "title, description, quantity, unit, unit_amount_minor, discount_minor, tax_rate_bps, billing_timing, gross_minor, net_minor, tax_minor, total_minor, position";

const REASON_LABELS: Record<string, string> = {
  discount: "a discount",
  non_standard_terms: "non-standard terms",
  margin_exception: "a margin exception",
};

export default async function ProposalPage(props: PageProps<"/dashboard/proposals/[id]">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/proposals/${id}`);
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: proposal, error } = await supabase
    .from("proposals")
    .select("*, prospects(id, name, company, email)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!proposal) notFound();

  const [versionsResult, eventsResult] = await Promise.all([
    supabase.from("proposal_versions").select("*").eq("proposal_id", id).order("version_number", { ascending: false }),
    supabase
      .from("proposal_events")
      .select("id, event_type, actor_type, actor_id, metadata, occurred_at, version_id")
      .eq("proposal_id", id)
      .order("occurred_at", { ascending: false })
      .limit(50),
  ]);
  if (versionsResult.error) throw fromPostgrestError(versionsResult.error);
  if (eventsResult.error) throw fromPostgrestError(eventsResult.error);
  const versions = versionsResult.data ?? [];
  const current = versions.find((version) => version.id === proposal.current_version_id) ?? versions[0];
  const accepted = versions.find((version) => version.id === proposal.accepted_version_id);
  if (!current) notFound();

  const [linesResult, proofLinksResult] = await Promise.all([
    supabase.from("proposal_line_items").select(LINE_COLUMNS).eq("version_id", current.id).order("position"),
    supabase.from("proposal_proof").select("proof_asset_id, position").eq("version_id", current.id).order("position"),
  ]);
  if (linesResult.error) throw fromPostgrestError(linesResult.error);
  const lines = linesResult.data ?? [];
  const attachedProofIds = (proofLinksResult.data ?? []).map((link) => link.proof_asset_id);

  const isOwner = proposal.owner_user_id === context.userId;
  const canManage = can(context, "proposals.manage") || (isOwner && can(context, "proposals.manage_own"));
  const canApprove = can(context, "proposals.approve");
  const open = !["accepted", "declined", "withdrawn"].includes(proposal.status);
  const today = todayIst();

  // Proof the author may attach: approved/published, unexpired, unwithdrawn.
  let proofOptions: { id: string; title: string; kind: string }[] = [];
  let attachedProof: ClientProof[] = [];
  if (can(context, "proof.read")) {
    const { data: proof } = await supabase
      .from("proof_assets")
      .select("id, kind, title, quote, author_name, author_role, company_name, narrative, metrics, publication_status, withdrawn_at, permission_expires_on, permitted_channels")
      .eq("organization_id", context.organizationId)
      .in("publication_status", ["approved", "published"])
      .is("withdrawn_at", null);
    const visible = (proof ?? []).filter(
      (asset) =>
        (!asset.permission_expires_on || asset.permission_expires_on >= today) &&
        asset.permitted_channels.includes("proposal"),
    );
    proofOptions = visible.map((asset) => ({ id: asset.id, title: asset.title, kind: asset.kind }));
    attachedProof = visible
      .filter((asset) => attachedProofIds.includes(asset.id))
      .map((asset) => ({ ...asset, metrics: (asset.metrics ?? []) as ClientProof["metrics"] }));
  }

  const preview = toClientVersion(current, lines, today);
  const previouslySent = versions.find((version) => version.sent_at && version.id !== current.id && version.version_number < current.version_number);
  const previousLines = previouslySent
    ? (await supabase.from("proposal_line_items").select(LINE_COLUMNS).eq("version_id", previouslySent.id).order("position")).data ?? []
    : [];
  const previousPreview = previouslySent ? toClientVersion(previouslySent, previousLines, today) : null;

  const actorIds = [...new Set((eventsResult.data ?? []).map((event) => event.actor_id).filter((value): value is string => Boolean(value)))];
  const { data: actors } = actorIds.length
    ? await supabase.from("profiles").select("id, display_name, email").in("id", actorIds)
    : { data: [] };
  const actorName = new Map((actors ?? []).map((actor) => [actor.id, actor.display_name || actor.email || "Team member"]));

  const hidden = (
    <>
      <input type="hidden" name="proposalId" value={proposal.id} />
      <input type="hidden" name="versionId" value={current.id} />
    </>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link
          href={`/dashboard/prospects/${proposal.prospect_id}`}
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          ← {proposal.prospects?.name ?? "Prospect"}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{proposal.title}</h1>
          <StatusBadge status={proposal.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Working on version {current.version_number} (<StatusBadge status={current.status} />) ·{" "}
          {formatMoney(current.total_minor, current.currency)}
          {proposal.accepted_at ? ` · accepted ${dateTime.format(new Date(proposal.accepted_at))}` : ""}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Next step</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {current.status === "draft" && canManage ? (
            <>
              <p>
                Save your edits, then submit. Submitted versions are locked; later edits create a new version.
                {current.requires_approval
                  ? ` This draft includes ${current.approval_reasons.map((reason) => REASON_LABELS[reason] ?? reason).join(", ")}, so it will need approval.`
                  : ""}
              </p>
              <ActionForm action={submitVersion} submitLabel="Submit version" pendingLabel="Checking…">
                {hidden}
              </ActionForm>
            </>
          ) : null}

          {current.status === "pending_approval" ? (
            canApprove ? (
              <ActionForm action={reviewVersion} submitLabel="Record decision">
                {hidden}
                <p>
                  Needs approval for{" "}
                  {current.approval_reasons.map((reason) => REASON_LABELS[reason] ?? reason).join(", ")}.
                </p>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="decision" value="approve" defaultChecked /> Approve
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="decision" value="reject" /> Send back with changes
                  </label>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="review-note">Note (required when sending back)</Label>
                  <Input id="review-note" name="note" />
                </div>
              </ActionForm>
            ) : (
              <p>Waiting for approval from someone with approval authority.</p>
            )
          ) : null}

          {current.status === "approved" && canManage ? (
            <ActionForm
              action={sendVersion}
              submitLabel={`Send version ${current.version_number} to client`}
              confirmMessage="Send this version? The client will see it through their secure link and it can no longer be edited."
            >
              {hidden}
              <p>
                This version is ready. Sending makes it the version the client sees
                {proposal.sent_version_id ? " and supersedes the one they have now" : ""}.
              </p>
            </ActionForm>
          ) : null}

          {current.status === "sent" && open && canManage ? (
            <ActionForm action={createRevision} submitLabel="Start a new version" variant="outline">
              <input type="hidden" name="proposalId" value={proposal.id} />
              <p>The client is reviewing version {current.version_number}. To change anything, start a new version.</p>
              <div className="space-y-1">
                <Label htmlFor="change-summary">What will change (shown to the client)</Label>
                <Input id="change-summary" name="changeSummary" required minLength={3} />
              </div>
            </ActionForm>
          ) : null}

          {proposal.status === "accepted" ? (
            <>
              <p>
                Accepted on {dateTime.format(new Date(proposal.accepted_at!))} against version{" "}
                {versions.find((version) => version.id === proposal.accepted_version_id)?.version_number}.
              </p>
              {can(context, "contracts.read") && accepted ? (
                <GenerateContract
                  context={context}
                  proposalId={proposal.id}
                  schedule={accepted.payment_schedule as ScheduleItem[]}
                  prospect={{
                    name: proposal.prospects?.name ?? "",
                    company: proposal.prospects?.company ?? null,
                    email: proposal.prospects?.email ?? null,
                  }}
                />
              ) : null}
            </>
          ) : null}
          {proposal.status === "declined" ? (
            <p>Declined by the client{proposal.decline_reason ? `: “${proposal.decline_reason}”` : "."}</p>
          ) : null}
          {!canManage && !canApprove ? <p>You can view this proposal but not change it.</p> : null}

          {open && canManage ? (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer font-medium">Withdraw proposal</summary>
              <ActionForm
                action={withdrawProposal}
                submitLabel="Withdraw"
                variant="destructive"
                confirmMessage="Withdraw this proposal? The client will no longer be able to accept it."
                className="mt-3"
              >
                <input type="hidden" name="proposalId" value={proposal.id} />
                <div className="space-y-1">
                  <Label htmlFor="withdraw-reason">Reason (audited)</Label>
                  <Textarea id="withdraw-reason" name="reason" rows={2} required />
                </div>
              </ActionForm>
            </details>
          ) : null}
        </CardContent>
      </Card>

      {current.status === "draft" && canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit version {current.version_number}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProposalEditor
              proposalId={proposal.id}
              versionId={current.id}
              proofOptions={proofOptions}
              defaults={versionToEditorValues(proposal.title, current, lines, attachedProofIds)}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{current.status === "draft" ? "Preview (as the client will see it)" : "Client view"}</CardTitle>
        </CardHeader>
        <CardContent>
          {preview && lines.length > 0 ? (
            <ProposalDocument
              title={proposal.title}
              version={preview}
              previousVersion={previousPreview}
              proof={attachedProof}
              preparedFor={proposal.prospects?.company ?? proposal.prospects?.name}
              organizationName={context.organizationName}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Add line items and save to see a preview.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Versions</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 text-sm">
              {versions.map((version) => (
                <li key={version.id} className="space-y-1 border-l-2 pl-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">v{version.version_number}</span>
                    <StatusBadge status={version.status} />
                    <span className="tabular-nums text-muted-foreground">
                      {formatMoney(version.total_minor, version.currency)}
                    </span>
                  </p>
                  {version.change_summary ? <p>{version.change_summary}</p> : null}
                  <p className="text-xs text-muted-foreground">
                    Created {dateTime.format(new Date(version.created_at))}
                    {version.sent_at ? ` · sent ${dateTime.format(new Date(version.sent_at))}` : ""}
                    {version.content_hash ? ` · terms ${version.content_hash.slice(0, 10)}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 text-sm">
              {(eventsResult.data ?? []).map((event) => (
                <li key={event.id} className="border-l-2 pl-3">
                  <p className="font-medium">{event.event_type.replace("proposal.", "").replaceAll("_", " ")}</p>
                  <p className="text-xs text-muted-foreground">
                    {dateTime.format(new Date(event.occurred_at))} ·{" "}
                    {event.actor_type === "client"
                      ? "Client"
                      : event.actor_id
                        ? (actorName.get(event.actor_id) ?? "Team member")
                        : "System"}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
