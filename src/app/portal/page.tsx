import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";

import { StatusBadge } from "@/components/status-badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/modules/proposals/money";
import { getSessionUser } from "@/server/auth/session";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

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
  const { data, error } = await supabase.rpc("client_proposals");
  if (error) throw fromPostgrestError(error);
  const proposals = listSchema.parse(data ?? []);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Your Atmors portal</h1>
        <p className="text-sm text-muted-foreground">
          {proposals.length > 0
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
