import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { daysAgoIso, isPast } from "@/lib/time";
import { formatMoney } from "@/modules/proposals/money";
import { PURPOSE_LABELS, formatMeetingTime } from "@/modules/scheduling/schema";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { completeTask } from "./actions";
import { memberPageAccess } from "./member-page";

export const metadata: Metadata = { title: "Work queue" };

// Queues from PRD §5.9 that arrive with later modules.
const UPCOMING_QUEUES = [
  { title: "Onboarding blockers", phase: "Phase 4" },
  { title: "Overdue delivery tasks", phase: "Phase 4" },
];

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function todayIstBounds(): { start: string; end: string } {
  const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return {
    start: new Date(`${day}T00:00:00+05:30`).toISOString(),
    end: new Date(`${day}T23:59:59+05:30`).toISOString(),
  };
}

const TASK_LINKS: Record<string, (id: string) => string> = {
  contract: (id) => `/dashboard/contracts/${id}`,
  invoice: (id) => `/dashboard/billing/invoices/${id}`,
  prospect: (id) => `/dashboard/prospects/${id}`,
  meeting: () => "/dashboard/meetings",
  payment_event: () => "/dashboard/billing",
  signature_event: () => "/dashboard/billing",
  payment: () => "/dashboard/billing",
};

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

const none = Promise.resolve({ data: [], error: null });

export default async function WorkQueuePage() {
  const access = await memberPageAccess("/dashboard");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  const supabase = await createSupabaseServerClient();
  const org = context.organizationId;
  const today = todayIstBounds();
  const finance = can(context, "finance.read");

  // Every query is RLS-scoped to what this member may see.
  const [followUps, openProposals, approvals, accepted, meetings, signatures, invoices, failedPayments, tasks] = await Promise.all([
    supabase
      .from("prospects")
      .select("id, name, company, status, next_action_at")
      .eq("organization_id", org)
      .lte("next_action_at", today.end)
      .not("status", "in", "(converted,disqualified,archived)")
      .order("next_action_at", { ascending: true })
      .limit(25),
    supabase
      .from("proposals")
      .select("id, title, status, sent_at, prospects(name)")
      .eq("organization_id", org)
      .in("status", ["sent", "viewed", "negotiation"])
      .order("sent_at", { ascending: true })
      .limit(25),
    can(context, "proposals.approve")
      ? supabase
          .from("proposal_versions")
          .select("id, proposal_id, version_number, total_minor, currency, approval_reasons, proposals!proposal_versions_proposal_id_fkey(title)")
          .eq("organization_id", org)
          .eq("status", "pending_approval")
          .limit(25)
      : none,
    supabase
      .from("proposals")
      .select("id, title, accepted_at, prospects(name)")
      .eq("organization_id", org)
      .eq("status", "accepted")
      .gte("accepted_at", daysAgoIso(14))
      .order("accepted_at", { ascending: false })
      .limit(25),
    supabase
      .from("meetings")
      .select("id, purpose, start_at, end_at, prospects(name, company)")
      .eq("organization_id", org)
      .in("status", ["booked", "rescheduled"])
      .gte("start_at", today.start)
      .lte("start_at", today.end)
      .order("start_at")
      .limit(25),
    can(context, "contracts.read")
      ? supabase
          .from("contracts")
          .select("id, title, status, sent_at, prospects(name)")
          .eq("organization_id", org)
          .in("status", ["sent", "viewed", "partially_signed"])
          .order("sent_at")
          .limit(25)
      : none,
    finance
      ? supabase
          .from("invoices")
          .select("id, invoice_number, status, balance_minor, currency, due_at, prospects(name)")
          .eq("organization_id", org)
          .in("status", ["overdue", "disputed"])
          .order("due_at")
          .limit(25)
      : none,
    finance
      ? supabase
          .from("payments")
          .select("id, invoice_id, amount_minor, currency, failure_code, failed_at")
          .eq("organization_id", org)
          .eq("status", "failed")
          .gte("failed_at", daysAgoIso(7))
          .order("failed_at", { ascending: false })
          .limit(25)
      : none,
    supabase
      .from("ops_tasks")
      .select("id, kind, title, detail, due_at, related_type, related_id, prospect_id")
      .eq("organization_id", org)
      .eq("status", "open")
      .order("due_at")
      .limit(50),
  ]);
  for (const result of [followUps, openProposals, approvals, accepted, meetings, signatures, invoices, failedPayments, tasks]) {
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
          title="Tasks"
          description="Callback requests, payment reviews, provider exceptions and kickoff preparation."
          empty="No open tasks."
          count={tasks.data?.length ?? 0}
        >
          {(tasks.data ?? []).map((task) => {
            const link = task.related_type && task.related_id ? TASK_LINKS[task.related_type]?.(task.related_id) : undefined;
            return (
              <li key={task.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span className="min-w-0 flex-1">
                  {link ? (
                    <Link href={link} className="hover:underline">
                      {task.title}
                    </Link>
                  ) : (
                    task.title
                  )}
                  {task.detail ? <span className="block text-sm text-muted-foreground">{task.detail}</span> : null}
                  <span className="block text-xs text-muted-foreground">{dateTime.format(new Date(task.due_at))}</span>
                </span>
                <ActionForm action={completeTask} submitLabel="Done" variant="outline">
                  <input type="hidden" name="taskId" value={task.id} />
                  <input type="hidden" name="outcome" value="done" />
                </ActionForm>
              </li>
            );
          })}
        </Queue>

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
                    {prospect.company ? <span className="text-muted-foreground"> · {prospect.company}</span> : null}
                  </span>
                  <span className={overdue ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                    {overdue ? "Overdue · " : ""}
                    {dateTime.format(new Date(prospect.next_action_at!))}
                  </span>
                </Link>
              </li>
            );
          })}
        </Queue>

        <Queue title="Meetings today" description="Booked calls in India time." empty="No calls today." count={meetings.data?.length ?? 0}>
          {(meetings.data ?? []).map((meeting) => (
            <li key={meeting.id} className="py-2">
              <Link href="/dashboard/meetings" className="flex flex-wrap items-center justify-between gap-2 hover:underline">
                <span>
                  {meeting.prospects?.company ?? meeting.prospects?.name}
                  <span className="text-muted-foreground"> · {PURPOSE_LABELS[meeting.purpose]}</span>
                </span>
                <span className="text-sm text-muted-foreground">{formatMeetingTime(meeting.start_at, meeting.end_at, "Asia/Kolkata")}</span>
              </Link>
            </li>
          ))}
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
                    {version.proposals?.title} · v{version.version_number}
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {formatMoney(version.total_minor, version.currency)} · {version.approval_reasons.join(", ").replaceAll("_", " ")}
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
                  <span className="text-muted-foreground"> · {proposal.prospects?.name}</span>
                </span>
                <StatusBadge status={proposal.status} />
              </Link>
            </li>
          ))}
        </Queue>

        <Queue
          title="Recently accepted"
          description="Generate the agreement from the accepted version."
          empty="No acceptances in the last 14 days."
          count={accepted.data?.length ?? 0}
        >
          {(accepted.data ?? []).map((proposal) => (
            <li key={proposal.id} className="py-2">
              <Link href={`/dashboard/proposals/${proposal.id}`} className="flex flex-wrap justify-between gap-2 hover:underline">
                <span>
                  {proposal.title}
                  <span className="text-muted-foreground"> · {proposal.prospects?.name}</span>
                </span>
                <span className="text-sm text-muted-foreground">{dateTime.format(new Date(proposal.accepted_at!))}</span>
              </Link>
            </li>
          ))}
        </Queue>

        {can(context, "contracts.read") ? (
          <Queue
            title="Agreements awaiting signature"
            description="Sent to the client, or signed by them and waiting for Atmors."
            empty="No agreements are waiting for signatures."
            count={signatures.data?.length ?? 0}
          >
            {(signatures.data ?? []).map((contract) => (
              <li key={contract.id} className="py-2">
                <Link href={`/dashboard/contracts/${contract.id}`} className="flex flex-wrap items-center justify-between gap-2 hover:underline">
                  <span>
                    {contract.title}
                    <span className="text-muted-foreground"> · {contract.prospects?.name}</span>
                  </span>
                  <StatusBadge status={contract.status} />
                </Link>
              </li>
            ))}
          </Queue>
        ) : null}

        {finance ? (
          <Queue
            title="Overdue, disputed or failed payments"
            description="Invoices past due or under dispute, and payment attempts that failed this week."
            empty="Nothing overdue or failed."
            count={(invoices.data?.length ?? 0) + (failedPayments.data?.length ?? 0)}
          >
            {(invoices.data ?? []).map((invoice) => (
              <li key={invoice.id} className="py-2">
                <Link href={`/dashboard/billing/invoices/${invoice.id}`} className="flex flex-wrap items-center justify-between gap-2 hover:underline">
                  <span>
                    {invoice.invoice_number}
                    <span className="text-muted-foreground"> · {invoice.prospects?.name}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-sm tabular-nums">{formatMoney(invoice.balance_minor, invoice.currency)}</span>
                    <StatusBadge status={invoice.status} />
                  </span>
                </Link>
              </li>
            ))}
            {(failedPayments.data ?? []).map((payment) => (
              <li key={payment.id} className="py-2">
                <Link href={`/dashboard/billing/invoices/${payment.invoice_id}`} className="flex flex-wrap items-center justify-between gap-2 hover:underline">
                  <span>
                    Failed payment {formatMoney(payment.amount_minor, payment.currency)}
                    <span className="text-muted-foreground"> · {payment.failure_code}</span>
                  </span>
                  <StatusBadge status="failed" />
                </Link>
              </li>
            ))}
          </Queue>
        ) : null}
      </div>

      <section aria-labelledby="upcoming" className="space-y-2">
        <h2 id="upcoming" className="text-sm font-medium text-muted-foreground">
          Coming with later phases
        </h2>
        <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {UPCOMING_QUEUES.map((queue) => (
            <li key={queue.title} className="rounded-full border border-dashed px-3 py-1">
              {queue.title} · {queue.phase}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
