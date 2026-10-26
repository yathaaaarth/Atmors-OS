import type { Metadata } from "next";
import Link from "next/link";

import { AssistantChat } from "@/components/ai/assistant-chat";
import { ProposalDocument } from "@/components/proposal/proposal-document";
import { PublicShell } from "@/components/public-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hashInvitationToken, isPlausibleInvitationToken } from "@/modules/crm/invitation-token";
import { invitationViewSchema, OPEN_PROPOSAL_STATUSES, type InvitationView } from "@/modules/proposals/client-view";
import { fromPostgrestError } from "@/server/errors";
import { logger } from "@/server/logger";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { askWithToken, confirmWithToken } from "./assistant-actions";
import { HelpRequest, VerifyToContinue } from "./invitation-actions";

export const metadata: Metadata = {
  title: "Your proposal",
  // Keep the token out of referrers to any third party.
  referrer: "no-referrer",
};

async function loadInvitation(token: string): Promise<InvitationView> {
  if (!isPlausibleInvitationToken(token)) return { state: "invalid" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("invitation_view", { p_token_hash: hashInvitationToken(token) });
  if (error) throw fromPostgrestError(error);
  const parsed = invitationViewSchema.safeParse(data);
  if (!parsed.success) {
    logger.error("invitation.view_shape_mismatch", { issues: parsed.error.issues.slice(0, 5) });
    throw new Error("Unexpected invitation view shape");
  }
  return parsed.data;
}

function Unavailable({ token, title, description }: { token: string; title: string; description: string }) {
  return (
    <PublicShell>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="font-heading text-xl font-semibold">{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <HelpRequest token={token} kind="new_link" withMessage={false} />
        </CardContent>
      </Card>
    </PublicShell>
  );
}

export default async function InvitationPage(props: PageProps<"/i/[token]">) {
  const { token } = await props.params;
  const view = await loadInvitation(token);

  // No record details are revealed for unusable links (AT-002, AT-003).
  if (view.state === "invalid") {
    return (
      <Unavailable
        token={token}
        title="This link isn't valid"
        description="Check that you opened the full link from your email. You can also ask Atmors for a new one."
      />
    );
  }
  if (view.state === "expired") {
    return (
      <Unavailable
        token={token}
        title="This link has expired"
        description="For your security, invitation links stop working after a while. Request a new one below."
      />
    );
  }
  if (view.state === "revoked") {
    return (
      <Unavailable
        token={token}
        title="This link is no longer active"
        description="Atmors has replaced or withdrawn this link. Request a new one if you still need access."
      />
    );
  }
  if (view.state === "redeemed") {
    return (
      <PublicShell>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="font-heading text-xl font-semibold">Continue in your portal</h1>
            </CardTitle>
            <CardDescription>This invitation is already linked to your account. Sign in to continue.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/login?next=/portal">Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </PublicShell>
    );
  }

  const proposal = view.proposal;
  const version = proposal?.version;
  const firstName = view.prospect_name.split(" ")[0];
  const open = proposal ? OPEN_PROPOSAL_STATUSES.includes(proposal.proposal.status) : false;

  return (
    <PublicShell>
      <section className="space-y-1">
        <p className="text-sm text-muted-foreground">Hi {firstName},</p>
        <p className="text-sm text-muted-foreground">
          {view.organization_name ?? "Atmors"} has prepared this for you. Take your time; you can come back to this
          link until it expires, ask questions, or request changes at any point.
        </p>
      </section>

      {proposal && version ? (
        <ProposalDocument
          title={proposal.proposal.title}
          version={version}
          previousVersion={proposal.previous_version}
          proof={proposal.proof}
          preparedFor={proposal.prospect.company ?? proposal.prospect.name}
          organizationName={view.organization_name}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="font-heading text-xl font-semibold">Your proposal is being prepared</h1>
            </CardTitle>
            <CardDescription>
              {proposal?.proposal.status === "withdrawn"
                ? "This proposal has been withdrawn. Your Atmors contact can tell you more."
                : "We'll let you know when it's ready. In the meantime, ask us anything."}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {proposal && version ? (
        <AssistantChat
          title="Questions about this proposal?"
          notice="An AI assistant answers from this proposal and Atmors' approved information only. It can't change terms or prices, and a person can take over any time. Questions are logged to help Atmors follow up."
          suggestions={["What's included?", "How does the payment schedule work?", "What happens after I accept?"]}
          hiddenFields={{ token }}
          ask={askWithToken}
          confirm={confirmWithToken}
        />
      ) : null}

      {version && open ? (
        <Card className="border-brand/40">
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Ready to go ahead?</h2>
            </CardTitle>
            {version.is_expired ? (
              <CardDescription>
                This version has passed its valid-until date. Ask for an updated version below.
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            {!version.is_expired ? <VerifyToContinue token={token} maskedEmail={view.masked_email} /> : null}
          </CardContent>
        </Card>
      ) : null}

      {proposal?.proposal.status === "accepted" ? (
        <p role="status" className="rounded-lg border p-4 text-sm">
          You accepted this proposal. Sign in to your portal for next steps.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-heading text-lg font-semibold">Questions or changes?</h2>
          </CardTitle>
          <CardDescription>Your message goes straight to your Atmors contact.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <HelpRequest token={token} kind="question" label="Ask a question" />
          {open ? <HelpRequest token={token} kind="changes" label="What would you like changed?" /> : null}
          <div className="space-y-2">
            <p className="text-sm font-medium">Prefer to talk?</p>
            <Button asChild variant="outline">
              <Link href={`/i/${token}/book`}>Book a call</Link>
            </Button>
            <p className="text-xs text-muted-foreground">Your place in the proposal is kept while you book.</p>
          </div>
        </CardContent>
      </Card>
    </PublicShell>
  );
}
