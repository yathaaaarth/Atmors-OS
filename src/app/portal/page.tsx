import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";

import { ActionForm } from "@/components/action-form";
import { MeetingSummary } from "@/components/booking/booking-panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { clientInvoiceListSchema } from "@/modules/billing/schema";
import { clientContractListSchema } from "@/modules/contracts/schema";
import { clientOnboardingSchema, clientWorkspaceSchema } from "@/modules/onboarding/schema";
import { formatMoney } from "@/modules/proposals/money";
import { PURPOSE_LABELS, clientMeetingSchema } from "@/modules/scheduling/schema";
import { getSessionUser } from "@/server/auth/session";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { cancelMeeting } from "./book/actions";

export const metadata: Metadata = { title: "Your portal" };

const JOURNEY = ["Proposal", "Agreement", "Payment", "Onboarding", "Kickoff"];

const listSchema = z.array(
  z.object({
    id: z.uuid(),
    title: z.string(),
    status: z.string(),
    sent_at: z.string().nullable(),
    total_minor: z.number(),
    currency: z.string(),
    valid_until: z.string().nullable(),
  }),
);

const INVITE_ERRORS: Record<string, string> = {
  FORBIDDEN: "That invitation was sent to a different email address than the one you signed in with.",
  INVITATION_EXPIRED: "That invitation link has expired. Ask Atmors for a new one.",
  INVITATION_REVOKED: "That invitation link is no longer active. Ask Atmors for a new one.",
};

export default async function PortalHomePage(props: PageProps<"/portal">) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/portal");
  const params = await props.searchParams;
  const inviteError = typeof params.invite_error === "string" ? params.invite_error : null;

  const supabase = await createSupabaseServerClient();
  const [proposalsResult, meetingsResult, contractsResult, invoicesResult, onboardingResult, workspaceResult] = await Promise.all([
    supabase.rpc("client_proposals"),
    supabase.rpc("client_meetings"),
    supabase.rpc("client_contracts"),
    supabase.rpc("client_invoices"),
    supabase.rpc("client_onboarding"),
    supabase.rpc("client_workspace"),
  ]);
  for (const result of [proposalsResult, meetingsResult, contractsResult, invoicesResult, onboardingResult, workspaceResult]) {
    if (result.error) throw fromPostgrestError(result.error);
  }
  const proposals = listSchema.parse(proposalsResult.data ?? []);
  const meetings = clientMeetingSchema.array().parse(meetingsResult.data ?? []);
  const contracts = clientContractListSchema.parse(contractsResult.data ?? []);
  const invoices = clientInvoiceListSchema.parse(invoicesResult.data ?? []);
  const upcoming = meetings.filter((meeting) => meeting.can_change);
  const onboarding = onboardingResult.data ? clientOnboardingSchema.parse(onboardingResult.data) : null;
  const workspace = workspaceResult.data ? clientWorkspaceSchema.parse(workspaceResult.data) : null;
  const hasAccess = proposals.length > 0 || contracts.length > 0;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Your Atmors portal</h1>
        <p className="text-sm text-muted-foreground">
          {hasAccess
            ? "Everything Atmors has shared with you."
            : "Nothing has been shared with you yet. When Atmors sends a proposal, it will appear here."}
        </p>
      </header>

      {inviteError ? (
        <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          {INVITE_ERRORS[inviteError] ?? "We couldn't link that invitation to your account. Ask Atmors for help."}
        </p>
      ) : null}

      {proposals.length > 0 ? (
        <ul className="space-y-3">
          {proposals.map((proposal) => (
            <li key={proposal.id}>
              <Link
                href={`/portal/proposals/${proposal.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-4 hover:bg-muted/50"
              >
                <span>
                  <span className="font-medium">{proposal.title}</span>
                  <span className="block text-sm tabular-nums text-muted-foreground">
                    {formatMoney(proposal.total_minor, proposal.currency)}
                  </span>
                </span>
                <StatusBadge status={proposal.status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {onboarding || workspace ? (
        <section aria-labelledby="getting-started" className="grid gap-3 sm:grid-cols-2">
          <h2 id="getting-started" className="sr-only">
            Getting started
          </h2>
          {onboarding ? (
            <Link href="/portal/onboarding" className="flex flex-col gap-2 rounded-lg border bg-card p-4 hover:bg-muted/50">
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">Onboarding</span>
                <StatusBadge status={onboarding.status} />
              </span>
              <span className="text-sm text-muted-foreground">
                {onboarding.status === "needs_information"
                  ? "Atmors needs a little more information."
                  : onboarding.status === "approved"
                    ? "Approved. Thank you!"
                    : ["submitted", "resubmitted"].includes(onboarding.status)
                      ? "With Atmors for review."
                      : "Tell us about your business and share your files."}
              </span>
            </Link>
          ) : null}
          {workspace ? (
            <Link href="/portal/workspace" className="flex flex-col gap-2 rounded-lg border bg-card p-4 hover:bg-muted/50">
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">Workspace</span>
                <StatusBadge status={workspace.status === "setting_up" ? "pending" : workspace.status} />
              </span>
              <span className="text-sm text-muted-foreground">
                {workspace.status === "active" ? "Milestones, shared tasks and updates." : "Opens once the agreed start conditions are met."}
              </span>
            </Link>
          ) : null}
        </section>
      ) : null}

      {contracts.length > 0 ? (
        <section aria-labelledby="agreements" className="space-y-3">
          <h2 id="agreements" className="font-heading text-lg font-semibold">
            Agreements
          </h2>
          <ul className="space-y-3">
            {contracts.map((contract) => (
              <li key={contract.id}>
                <Link
                  href={`/portal/contracts/${contract.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-4 hover:bg-muted/50"
                >
                  <span className="font-medium">
                    {contract.title}
                    {["sent", "viewed"].includes(contract.status) ? (
                      <span className="block text-sm font-normal text-muted-foreground">Ready for your signature</span>
                    ) : null}
                  </span>
                  <StatusBadge status={contract.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {invoices.length > 0 ? (
        <section aria-labelledby="invoices" className="space-y-3">
          <h2 id="invoices" className="font-heading text-lg font-semibold">
            Invoices
          </h2>
          <ul className="space-y-3">
            {invoices.map((invoice) => (
              <li key={invoice.id}>
                <Link
                  href={`/portal/invoices/${invoice.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-4 hover:bg-muted/50"
                >
                  <span>
                    <span className="font-medium">
                      {invoice.invoice_number} · {invoice.label}
                    </span>
                    <span className="block text-sm tabular-nums text-muted-foreground">
                      {invoice.balance_minor > 0
                        ? `${formatMoney(invoice.balance_minor, invoice.currency)} due`
                        : formatMoney(invoice.total_minor, invoice.currency)}
                    </span>
                  </span>
                  <StatusBadge status={invoice.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasAccess ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Calls</CardTitle>
            <CardDescription>Optional at any stage. Book a time that suits you, or ask us to call you.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {upcoming.length > 0 ? (
              <ul className="space-y-3 text-sm">
                {upcoming.map((meeting) => (
                  <li key={meeting.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{PURPOSE_LABELS[meeting.purpose]}</span>
                      <span className="block text-muted-foreground">
                        <MeetingSummary meeting={meeting} timeZone={meeting.timezone} />
                      </span>
                    </span>
                    <ActionForm action={cancelMeeting} submitLabel="Cancel" variant="outline" confirmMessage="Cancel this call?">
                      <input type="hidden" name="meetingId" value={meeting.id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button asChild variant="outline">
              <Link href="/portal/book">Book a call</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
          <CardDescription>You can pause at any step, ask questions or book a call. Your progress is kept.</CardDescription>
        </CardHeader>
        <ol className="grid gap-2 px-6 pb-6 sm:grid-cols-5">
          {JOURNEY.map((step, index) => (
            <li key={step} className="rounded-md border px-3 py-2 text-sm">
              <span className="block text-xs text-muted-foreground">Step {index + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
