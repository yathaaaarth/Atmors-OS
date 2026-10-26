import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { AssistantChat } from "@/components/ai/assistant-chat";
import { ActionForm } from "@/components/action-form";
import { StatusBadge, statusLabel } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { invitationState } from "@/modules/crm/invitation-token";
import { prospectStateMachine } from "@/modules/crm/prospect-state";
import { OUTREACH_CHANNELS, OUTREACH_DIRECTIONS, toIstDateTimeLocal } from "@/modules/crm/schema";
import { CURRENCIES, formatMoney } from "@/modules/proposals/money";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import { createProposal, logOutreach, transitionProspect } from "../actions";
import { ProspectForm } from "../prospect-form";

import { askCopilotAction, confirmCopilotAction } from "./copilot-actions";
import { InvitationsPanel } from "./invitations-panel";

export const metadata: Metadata = { title: "Prospect" };

const selectClass = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm";
const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function ProspectPage(props: PageProps<"/dashboard/prospects/[id]">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/prospects/${id}`);
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: prospect, error } = await supabase.from("prospects").select("*").eq("id", id).maybeSingle();
  if (error) throw fromPostgrestError(error);
  // RLS returns nothing for prospects this member may not see; same 404 either way.
  if (!prospect) notFound();

  const [outreach, invitations, proposals] = await Promise.all([
    supabase
      .from("outreach_events")
      .select("id, channel, direction, event_type, summary, occurred_at, actor_id")
      .eq("prospect_id", id)
      .order("occurred_at", { ascending: false })
      .limit(50),
    supabase
      .from("invitations")
      .select("id, proposal_id, expires_at, sent_at, opened_at, redeemed_at, revoked_at, created_at")
      .eq("prospect_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("proposals")
      .select("id, title, status, sent_at, current_version_id, proposal_versions!proposals_current_version_fkey(total_minor, currency, version_number)")
      .eq("prospect_id", id)
      .order("created_at", { ascending: false }),
  ]);
  for (const result of [outreach, invitations, proposals]) {
    if (result.error) throw fromPostgrestError(result.error);
  }

  const isOwner = prospect.owner_user_id === context.userId;
  const canManage = can(context, "prospects.write") || (isOwner && can(context, "prospects.write_own"));
  const canPropose = can(context, "proposals.manage") || (isOwner && can(context, "proposals.manage_own"));
  const nextStates = prospectStateMachine.nextStates(prospect.status);
  const proposalTitles = new Map((proposals.data ?? []).map((proposal) => [proposal.id, proposal.title]));

  let owners: { id: string; name: string }[] | undefined;
  if (can(context, "prospects.write")) {
    const { data } = await supabase
      .from("organization_memberships")
      .select("user_id, profiles(display_name, email)")
      .eq("organization_id", context.organizationId)
      .eq("status", "active");
    owners = (data ?? []).map((row) => ({
      id: row.user_id,
      name: row.profiles?.display_name || row.profiles?.email || row.user_id,
    }));
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link href="/dashboard/prospects" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Prospects
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{prospect.name}</h1>
          <StatusBadge status={prospect.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {[prospect.company, prospect.email, prospect.target_service].filter(Boolean).join(" · ")}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Proposals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {(proposals.data ?? []).length > 0 ? (
                <ul className="divide-y rounded-lg border">
                  {(proposals.data ?? []).map((proposal) => {
                    const version = proposal.proposal_versions;
                    return (
                      <li key={proposal.id}>
                        <Link
                          href={`/dashboard/proposals/${proposal.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-muted/50"
                        >
                          <span className="font-medium">{proposal.title}</span>
                          <span className="flex items-center gap-2 text-sm">
                            {version ? (
                              <span className="tabular-nums text-muted-foreground">
                                v{version.version_number} · {formatMoney(version.total_minor, version.currency)}
                              </span>
                            ) : null}
                            <StatusBadge status={proposal.status} />
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No proposals yet.</p>
              )}
              {canPropose && !["disqualified", "archived"].includes(prospect.status) ? (
                <ActionForm action={createProposal} submitLabel="Start a proposal" pendingLabel="Creating…" variant="outline">
                  <input type="hidden" name="prospectId" value={prospect.id} />
                  <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                    <div className="space-y-1">
                      <Label htmlFor="proposal-title">Title</Label>
                      <Input id="proposal-title" name="title" required placeholder="e.g. LinkedIn growth retainer" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="proposal-currency">Currency</Label>
                      <select id="proposal-currency" name="currency" defaultValue="INR" className={selectClass}>
                        {CURRENCIES.map((currency) => (
                          <option key={currency}>{currency}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </ActionForm>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Secure invitation links</CardTitle>
            </CardHeader>
            <CardContent>
              <InvitationsPanel
                prospectId={prospect.id}
                hasEmail={Boolean(prospect.email)}
                canManage={canManage}
                proposals={(proposals.data ?? [])
                  .filter((proposal) => !["withdrawn", "declined"].includes(proposal.status))
                  .map((proposal) => ({ id: proposal.id, title: proposal.title }))}
                invitations={(invitations.data ?? []).map((invitation) => ({
                  id: invitation.id,
                  state: invitationState(invitation),
                  expiresAt: invitation.expires_at,
                  createdAt: invitation.created_at,
                  proposalTitle: invitation.proposal_id ? (proposalTitles.get(invitation.proposal_id) ?? null) : null,
                }))}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Outreach and activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {canManage ? (
                <ActionForm action={logOutreach} submitLabel="Log activity" successMessage="Logged." variant="outline">
                  <input type="hidden" name="prospectId" value={prospect.id} />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="outreach-channel">Channel</Label>
                      <select id="outreach-channel" name="channel" className={selectClass}>
                        {OUTREACH_CHANNELS.map((channel) => (
                          <option key={channel}>{channel}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="outreach-direction">Direction</Label>
                      <select id="outreach-direction" name="direction" className={selectClass}>
                        {OUTREACH_DIRECTIONS.map((direction) => (
                          <option key={direction}>{direction}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="outreach-next">Next follow-up (IST)</Label>
                      <Input id="outreach-next" name="nextActionAt" type="datetime-local" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="outreach-summary">Summary</Label>
                    <Textarea id="outreach-summary" name="summary" rows={2} required />
                  </div>
                </ActionForm>
              ) : null}
              <ol className="space-y-3">
                {(outreach.data ?? []).map((event) => (
                  <li key={event.id} className="border-l-2 pl-3 text-sm">
                    <p className="text-xs text-muted-foreground">
                      {dateTime.format(new Date(event.occurred_at))} · {event.direction} · {event.channel} ·{" "}
                      {event.event_type}
                    </p>
                    {event.summary ? <p className="whitespace-pre-line">{event.summary}</p> : null}
                  </li>
                ))}
                {(outreach.data ?? []).length === 0 ? (
                  <li className="text-sm text-muted-foreground">No activity logged yet.</li>
                ) : null}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                Next follow-up:{" "}
                <span className="font-medium">
                  {prospect.next_action_at ? dateTime.format(new Date(prospect.next_action_at)) : "not set"}
                </span>
              </p>
              {canManage && nextStates.length > 0 ? (
                <ActionForm action={transitionProspect} submitLabel="Change status" variant="outline">
                  <input type="hidden" name="prospectId" value={prospect.id} />
                  <div className="space-y-1">
                    <Label htmlFor="status-to">Move to</Label>
                    <select id="status-to" name="to" className={selectClass}>
                      {nextStates.map((state) => (
                        <option key={state} value={state}>
                          {statusLabel(state)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="status-reason">Reason (audited)</Label>
                    <Input id="status-reason" name="reason" required minLength={3} />
                  </div>
                </ActionForm>
              ) : null}
            </CardContent>
          </Card>

          {canManage ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <ProspectForm
                  prospectId={prospect.id}
                  owners={owners}
                  defaults={{
                    name: prospect.name,
                    company: prospect.company ?? "",
                    email: prospect.email ?? "",
                    contact_channel: prospect.contact_channel as "email",
                    contact_handle: prospect.contact_handle ?? "",
                    source: prospect.source ?? "",
                    target_service: prospect.target_service ?? "",
                    notes: prospect.notes ?? "",
                    next_action_at: toIstDateTimeLocal(prospect.next_action_at),
                    owner_user_id: prospect.owner_user_id,
                  }}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {can(context, "ai.copilot") ? (
        <AssistantChat
          title="Copilot"
          notice="Read-only. It sees only the records you can see, and suggests tasks or drafts that you confirm or send yourself."
          suggestions={["Summarize where this client stands", "What is blocking progress?", "Draft a follow-up message"]}
          hiddenFields={{ prospectId: prospect.id }}
          ask={askCopilotAction}
          confirm={confirmCopilotAction}
        />
      ) : null}
    </div>
  );
}
