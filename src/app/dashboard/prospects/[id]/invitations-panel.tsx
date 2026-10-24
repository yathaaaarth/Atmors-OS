"use client";

import { useActionState, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InvitationState } from "@/modules/crm/invitation-token";

import { createInvitation, manageInvitation } from "../actions";

type Result =
  | { ok: true; data: { url?: string } }
  | { ok: false; error: { message: string; correlation_id: string } }
  | null;

function OneTimeLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="space-y-2 rounded-md border border-brand/40 bg-accent/50 p-3 text-sm">
      <p className="font-medium">Copy this link now. It is shown only once.</p>
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="Invitation link" onFocus={(event) => event.target.select()} />
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Send it to the prospect yourself, then mark the invitation as sent. Atmors only stores a fingerprint of the link.
      </p>
    </div>
  );
}

function ErrorText({ state }: { state: Result }) {
  if (!state || state.ok) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {state.error.message} <span className="text-xs">(ref {state.error.correlation_id.slice(0, 8)})</span>
    </p>
  );
}

export type InvitationRowData = {
  id: string;
  state: InvitationState;
  expiresAt: string;
  proposalTitle: string | null;
  createdAt: string;
};

function InvitationRow({ prospectId, invitation }: { prospectId: string; invitation: InvitationRowData }) {
  const [state, action, pending] = useActionState(manageInvitation as (s: Result, f: FormData) => Promise<Result>, null);
  const [mode, setMode] = useState<"revoke" | "extend" | "replace" | null>(null);
  const active = !["revoked", "redeemed"].includes(invitation.state);
  const formatter = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <StatusBadge status={invitation.state} />{" "}
          <span className="text-muted-foreground">
            {invitation.proposalTitle ? `for “${invitation.proposalTitle}”` : "general access"} · expires{" "}
            {formatter.format(new Date(invitation.expiresAt))}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {invitation.state === "created" ? (
            <form action={action}>
              <input type="hidden" name="prospectId" value={prospectId} />
              <input type="hidden" name="invitationId" value={invitation.id} />
              <input type="hidden" name="action" value="mark_sent" />
              <Button size="sm" variant="outline" disabled={pending}>
                Mark as sent
              </Button>
            </form>
          ) : null}
          {active ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setMode(mode === "extend" ? null : "extend")}>
                Extend
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMode(mode === "replace" ? null : "replace")}>
                Replace link
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setMode(mode === "revoke" ? null : "revoke")}>
                Revoke
              </Button>
            </>
          ) : invitation.state !== "redeemed" ? (
            <Button size="sm" variant="outline" onClick={() => setMode(mode === "replace" ? null : "replace")}>
              Issue new link
            </Button>
          ) : null}
        </div>
      </div>
      {mode ? (
        <form
          action={action}
          className="grid gap-2 sm:grid-cols-[1fr_6rem_auto] sm:items-end"
          onSubmit={(event) => {
            if (mode === "revoke" && !window.confirm("Revoke this link? It stops working immediately.")) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="prospectId" value={prospectId} />
          <input type="hidden" name="invitationId" value={invitation.id} />
          <input type="hidden" name="action" value={mode} />
          <div className="space-y-1">
            <Label htmlFor={`reason-${invitation.id}`}>Reason (audited)</Label>
            <Input id={`reason-${invitation.id}`} name="reason" required minLength={3} />
          </div>
          {mode !== "revoke" ? (
            <div className="space-y-1">
              <Label htmlFor={`days-${invitation.id}`}>Days</Label>
              <Input id={`days-${invitation.id}`} name="days" type="number" min={1} max={30} defaultValue={14} />
            </div>
          ) : (
            <span />
          )}
          <Button type="submit" size="sm" variant={mode === "revoke" ? "destructive" : "default"} disabled={pending}>
            {mode === "revoke" ? "Revoke now" : mode === "extend" ? "Extend" : "Create new link"}
          </Button>
        </form>
      ) : null}
      <ErrorText state={state} />
      {state?.ok && state.data.url ? <OneTimeLink url={state.data.url} /> : null}
    </li>
  );
}

export function InvitationsPanel({
  prospectId,
  hasEmail,
  canManage,
  proposals,
  invitations,
}: {
  prospectId: string;
  hasEmail: boolean;
  canManage: boolean;
  proposals: { id: string; title: string }[];
  invitations: InvitationRowData[];
}) {
  const [state, action, pending] = useActionState(createInvitation as (s: Result, f: FormData) => Promise<Result>, null);

  return (
    <div className="space-y-4">
      {canManage ? (
        hasEmail ? (
          <form action={action} className="grid gap-3 sm:grid-cols-[1fr_6rem_auto] sm:items-end">
            <input type="hidden" name="prospectId" value={prospectId} />
            <div className="space-y-1">
              <Label htmlFor="invite-proposal">Proposal to share</Label>
              <select
                id="invite-proposal"
                name="proposalId"
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                <option value="">None yet (welcome only)</option>
                {proposals.map((proposal) => (
                  <option key={proposal.id} value={proposal.id}>
                    {proposal.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="invite-days">Expires in (days)</Label>
              <Input id="invite-days" name="days" type="number" min={1} max={30} defaultValue={14} />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create secure link"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Add an email address before inviting this prospect.</p>
        )
      ) : null}
      <ErrorText state={state} />
      {state?.ok && state.data.url ? <OneTimeLink url={state.data.url} /> : null}
      {invitations.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {invitations.map((invitation) =>
            canManage ? (
              <InvitationRow key={invitation.id} prospectId={prospectId} invitation={invitation} />
            ) : (
              <li key={invitation.id} className="p-4 text-sm">
                <StatusBadge status={invitation.state} />
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No invitations yet.</p>
      )}
    </div>
  );
}
