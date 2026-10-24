import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { daysAgoIso, isPast } from "@/lib/time";
import { formatMoney } from "@/modules/proposals/money";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "./member-page";

export const metadata: Metadata = { title: "Work queue" };

// Queues from PRD Â§5.9 that arrive with later modules.
const UPCOMING_QUEUES = [
  { title: "Meetings today", phase: "Phase 3" },
  { title: "Contracts awaiting signature", phase: "Phase 3" },
  { title: "Overdue or failed invoices", phase: "Phase 3" },
  { title: "Onboarding blockers", phase: "Phase 4" },
  { title: "Kickoff-ready clients", phase: "Phase 4" },
  { title: "Overdue delivery tasks", phase: "Phase 4" },
];

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function endOfTodayIst(): string {
  const istNow = new Date(Date.now() + 330 * 60_000);
  const day = istNow.toISOString().slice(0, 10);
  return new Date(`${day}T23:59:59+05:30`).toISOString();
}

function Queue({
  title,
  description,
  empty,
  children,
  count,
}: {
  title: string;
  description: string;
  empty: string;
  children: React.ReactNode;
  count: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{title}</span>
          <span className="rounded-full bg-muted px-2 text-sm tabular-nums" aria-label={`${count} items`}>
            {count}
          </span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {count > 0 ? <ul className="divide-y">{children}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}
      </CardContent>
    </Card>
  );
}

export default async function WorkQueuePage() {
  const access = await memberPageAccess("/dashboard");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  const supabase = await createSupabaseServerClient();

  // Every query is RLS-scoped to what this member may see.
  const [followUps, openProposals, approvals, accepted] = await Promise.all([
    supabase
      .from("prospects")
      .select("id, name, company, status, next_action_at")
      .eq("organization_id", context.organizationId)
      .lte("next_action_at", endOfTodayIst())
      .not("status", "in", "(converted,disqualified,archived)")
      .order("next_action_at", { ascending: true })
      .limit(25),
    supabase
      .from("proposals")
      .select("id, title, status, sent_at, prospects(name)")
      .eq("organization_id", context.organizationId)
      .in("status", ["sent", "viewed", "negotiation"])
      .order("sent_at", { ascending: true })
      .limit(25),
    can(context, "proposals.approve")
      ? supabase
          .from("proposal_versions")
          .select("id, proposal_id, version_number, total_minor, currency, approval_reasons, proposals!proposal_versions_proposal_id_fkey(title)")
          .eq("organization_id", context.organizationId)
          .eq("status", "pending_approval")
          .limit(25)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("proposals")
      .select("id, title, accepted_at, prospects(name)")
      .eq("organization_id", context.organizationId)
      .eq("status", "accepted")
      .gte("accepted_at", daysAgoIso(14))
      .order("accepted_at", { ascending: false })
      .limit(25),
  ]);
  for (const result of [followUps, openProposals, approvals, accepted]) {
    if (result.error) throw fromPostgrestError(result.error);
  }
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Work queue</h1>
        <p className="text-sm text-muted-foreground">Welcome, {context.displayName}. Here is what needs attention.</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Queue
          title="Follow-ups due"
          description="Prospects whose next action is today or overdue, including client requests."
          empty="No follow-ups due today."
          count={followUps.data?.length ?? 0}
        >
          {(followUps.data ?? []).map((prospect) => {
            const overdue = isPast(prospect.next_action_at);
            return (
              <li key={prospect.id} className="py-2">
                <Link href={`/dashboard/prospects/${prospect.id}`} className="flex flex-wrap items-center justify-between gap-2 hover:underline">
                  <span>
                    {prospect.name}
                    {prospect.company ? <span className="text-muted-foreground"> Â· {prospect.company}</span> : null}
                  </span>
                  <span className={overdue ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                    {overdue ? "Overdue Â· " : ""}
                    {dateTime.format(new Date(prospect.next_action_at!))}
                  </span>
                </Link>
              </li>
            );
          })}
        </Queue>

        {can(context, "proposals.approve") ? (
          <Queue
            title="Awaiting your approval"
            description="Versions with discounts, non-standard terms or margin exceptions."
            empty="Nothing waiting for approval."
            count={approvals.data?.length ?? 0}
          >
            {(approvals.data ?? []).map((version) => (
              <li key={version.id} className="py-2">
                <Link href={`/dashboard/proposals/${version.proposal_id}`} className="flex flex-wrap justify-between gap-2 hover:underline">
                  <span>
                    {version.proposals?.title} Â· v{version.version_number}
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {formatMoney(version.total_minor, version.currency)} Â· {version.approval_reasons.join(", ").replaceAll("_", " ")}
                  </span>
                </Link>
              </li>
            ))}
          </Queue>
        ) : null}

        <Queue
          title="Proposals awaiting the client"
          description="Sent, viewed, or with changes requested. Oldest first."
          empty="No proposals are waiting on clients."
          count={openProposals.data?.length ?? 0}
        >
          {(openProposals.data ?? []).map((proposal) => (
            <li key={proposal.id} className="py-2">
              <Link href={`/dashboard/proposals/${proposal.id}`} className="flex flex-wrap items-center justify-between gap-2 hover:underline">
                <span>
                  {proposal.title}
                  <span className="text-muted-foreground"> Â· {proposal.prospects?.name}</span>
                </span>
                <StatusBadge status={proposal.status} />
              </Link>
            </li>
          ))}
        </Queue>

        <Queue
          title="Recently accepted"
          description="Ready for the agreement step (contracts arrive in Phase 3)."
          empty="No acceptances in the last 14 days."
          count={accepted.data?.length ?? 0}
        >
          {(accepted.data ?? []).map((proposal) => (
            <li key={proposal.id} className="py-2">
              <Link href={`/dashboard/proposals/${proposal.id}`} className="flex flex-wrap justify-between gap-2 hover:underline">
                <span>
                  {proposal.title}
                  <span className="text-muted-foreground"> Â· {proposal.prospects?.name}</span>
                </span>
                <span className="text-sm text-muted-foreground">{dateTime.format(new Date(proposal.accepted_at!))}</span>
              </Link>
            </li>
          ))}
        </Queue>
      </div>

      <section aria-labelledby="upcoming" className="space-y-2">
        <h2 id="upcoming" className="text-sm font-medium text-muted-foreground">
          Coming with later phases
        </h2>
        <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {UPCOMING_QUEUES.map((queue) => (
            <li key={queue.title} className="rounded-full border border-dashed px-3 py-1">
              {queue.title} Â· {queue.phase}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
