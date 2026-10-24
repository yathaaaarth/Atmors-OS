import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ActionForm } from "@/components/action-form";
import { ProposalDocument } from "@/components/proposal/proposal-document";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { clientProposalSchema, OPEN_PROPOSAL_STATUSES } from "@/modules/proposals/client-view";
import { formatMoney } from "@/modules/proposals/money";
import { getSessionUser } from "@/server/auth/session";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { acceptProposal, respondToProposal } from "../../actions";

export const metadata: Metadata = { title: "Proposal" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function PortalProposalPage(props: PageProps<"/portal/proposals/[id]">) {
  const { id } = await props.params;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/portal/proposals/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_proposal_view", { p_proposal_id: id });
  if (error) {
    // Same response for missing and not-yours (AT-024).
    if (fromPostgrestError(error).code === "NOT_FOUND") notFound();
    throw fromPostgrestError(error);
  }
  const view = clientProposalSchema.parse(data);
  const version = view.version;
  const status = view.proposal.status;
  const open = OPEN_PROPOSAL_STATUSES.includes(status);

  return (
    <div className="space-y-8">
      <Link href="/portal" className="text-sm text-muted-foreground underline underline-offset-4">
        ← Your portal
      </Link>

      {version ? (
        <ProposalDocument
          title={view.proposal.title}
          version={version}
          previousVersion={view.previous_version}
          proof={view.proof}
          preparedFor={view.prospect.company ?? view.prospect.name}
          organizationName={view.organization_name}
        />
      ) : (
        <p className="rounded-lg border p-4 text-sm">This proposal is being prepared.</p>
      )}

      {status === "accepted" ? (
        <Card role="status">
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Accepted</h2>
            </CardTitle>
            <CardDescription>
              You accepted version {version?.version_number}
              {view.proposal.accepted_at ? ` on ${dateTime.format(new Date(view.proposal.accepted_at))}` : ""}. Atmors
              will send the agreement for signature next.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {status === "declined" ? (
        <p role="status" className="rounded-lg border p-4 text-sm">
          You declined this proposal. If you change your mind, reply to your Atmors contact.
        </p>
      ) : null}

      {version && open ? (
        <>
          <Card className="border-brand/40">
            <CardHeader>
              <CardTitle>
                <h2 className="font-heading text-lg font-semibold">Accept this proposal</h2>
              </CardTitle>
              <CardDescription>
                {version.is_expired
                  ? "This version has passed its valid-until date, so it can't be accepted. Request an updated version below."
                  : `You're accepting version ${version.version_number} for ${formatMoney(version.total_minor, version.currency)}, exactly as shown above. The agreement follows for signature.`}
              </CardDescription>
            </CardHeader>
            {!version.is_expired ? (
              <CardContent>
                <ActionForm
                  action={acceptProposal}
                  submitLabel="Accept proposal"
                  pendingLabel="Recording acceptance…"
                  successMessage="Accepted. Thank you!"
                  confirmMessage={`Accept version ${version.version_number} of this proposal?`}
                >
                  <input type="hidden" name="proposalId" value={view.proposal.id} />
                  <input type="hidden" name="versionId" value={version.id} />
                  <input type="hidden" name="contentHash" value={version.content_hash ?? ""} />
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
                    <span>
                      I have read version {version.version_number}, including the scope, payment schedule and terms, and
                      I accept it on behalf of {view.prospect.company ?? view.prospect.name}.
                    </span>
                  </label>
                </ActionForm>
              </CardContent>
            ) : null}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="font-heading text-lg font-semibold">Not quite right?</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 sm:grid-cols-2">
              <ActionForm
                action={respondToProposal}
                submitLabel="Request changes"
                variant="outline"
                successMessage="Sent. Your Atmors contact will follow up."
              >
                <input type="hidden" name="proposalId" value={view.proposal.id} />
                <input type="hidden" name="response" value="request_changes" />
                <div className="space-y-1">
                  <Label htmlFor="changes-message">What would you like changed?</Label>
                  <Textarea id="changes-message" name="message" rows={3} maxLength={2000} />
                </div>
              </ActionForm>
              <ActionForm
                action={respondToProposal}
                submitLabel="Decline proposal"
                variant="destructive"
                confirmMessage="Decline this proposal?"
              >
                <input type="hidden" name="proposalId" value={view.proposal.id} />
                <input type="hidden" name="response" value="decline" />
                <div className="space-y-1">
                  <Label htmlFor="decline-message">Anything you&apos;d like to share? (optional)</Label>
                  <Textarea id="decline-message" name="message" rows={3} maxLength={2000} />
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
