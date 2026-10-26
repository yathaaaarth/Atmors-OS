import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { isPast } from "@/lib/time";
import { describeBlockingReason } from "@/modules/contracts/schema";
import { KICKOFF_BLOCKER_LABELS } from "@/modules/onboarding/schema";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import {
  evaluateWorkspace,
  overrideActivation,
  postWorkspaceUpdate,
  saveMilestone,
  saveTask,
  setDeliveryStatus,
  setWorkspaceMember,
  transitionWorkspace,
  updateTaskStatus,
} from "../actions";

export const metadata: Metadata = { title: "Workspace" };

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const select = "h-9 rounded-md border bg-background px-2 text-sm";

const NEXT_TASK_STATUS: Record<string, { to: string; label: string }[]> = {
  todo: [{ to: "in_progress", label: "Start" }, { to: "blocked", label: "Blocked" }],
  in_progress: [{ to: "done", label: "Done" }, { to: "blocked", label: "Blocked" }],
  blocked: [{ to: "in_progress", label: "Unblock" }],
  done: [{ to: "in_progress", label: "Reopen" }],
  cancelled: [{ to: "todo", label: "Restore" }],
};

export default async function WorkspacePage(props: PageProps<"/dashboard/workspaces/[id]">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/workspaces/${id}`);
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: workspace, error } = await supabase.from("workspaces").select("*").eq("id", id).maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!workspace) notFound();

  const [members, milestones, tasks, updates, onboarding, staff] = await Promise.all([
    supabase.from("workspace_members").select("user_id, role, profiles!workspace_members_user_id_fkey(display_name, email)").eq("workspace_id", id),
    supabase.from("milestones").select("*").eq("workspace_id", id).order("position").order("due_at"),
    supabase.from("tasks").select("*").eq("workspace_id", id).order("due_at", { nullsFirst: false }),
    supabase.from("workspace_updates").select("*").eq("workspace_id", id).order("created_at", { ascending: false }).limit(50),
    supabase.from("onboardings").select("id, status").eq("prospect_id", workspace.prospect_id).maybeSingle(),
    can(context, "workspaces.manage")
      ? supabase.from("organization_memberships").select("user_id, role, profiles(display_name, email)").eq("organization_id", context.organizationId).eq("status", "active")
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [members, milestones, tasks, updates, onboarding, staff]) {
    if (result.error) throw fromPostgrestError(result.error);
  }

  const isLead = (members.data ?? []).some((member) => member.user_id === context.userId && member.role === "lead");
  const canManage = can(context, "workspaces.manage") || isLead;
  const name = (member: { profiles: { display_name: string; email: string | null } | null }) =>
    member.profiles?.display_name || member.profiles?.email || "Member";
  const memberName = new Map((members.data ?? []).map((member) => [member.user_id, name(member)]));
  const hidden = <input type="hidden" name="workspaceId" value={workspace.id} />;
  const deliveryMoves: Record<string, string[]> = { kickoff_ready: ["in_progress"], in_progress: ["paused", "completed"], paused: ["in_progress"] };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <Link href="/dashboard/workspaces" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Workspaces
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{workspace.client_name}</h1>
          <StatusBadge status={workspace.status} />
          <StatusBadge status={workspace.delivery_status} />
          {workspace.override_active ? (
            <span className="rounded border border-amber-500/60 px-2 py-0.5 text-xs font-medium">
              Manual override: {workspace.override_reason}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {workspace.activated_at ? `Active since ${dateTime.format(new Date(workspace.activated_at))}` : "Not active yet"}
          {onboarding.data ? (
            <>
              {" · onboarding "}
              <Link href={`/dashboard/onboarding/${onboarding.data.id}`} className="underline underline-offset-4">
                {onboarding.data.status.replaceAll("_", " ")}
              </Link>
            </>
          ) : null}
          {can(context, "contracts.read") ? (
            <>
              {" · "}
              <Link href={`/dashboard/contracts/${workspace.contract_id}`} className="underline underline-offset-4">
                agreement
              </Link>
            </>
          ) : null}
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Activation</CardTitle>
            <CardDescription>Evaluated from the agreement&apos;s own conditions using signed, paid and approved records.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {workspace.status === "blocked" ? (
              <ul className="list-disc pl-5">
                {workspace.blocked_reasons.map((reason) => (
                  <li key={reason}>{describeBlockingReason(reason)}</li>
                ))}
              </ul>
            ) : (
              <p>{workspace.status === "active" ? "Active." : `Workspace is ${workspace.status}.`}</p>
            )}
            {workspace.status_reason ? <p className="text-muted-foreground">Reason: {workspace.status_reason}</p> : null}
            <ActionForm action={evaluateWorkspace} submitLabel="Re-evaluate" variant="outline">
              {hidden}
            </ActionForm>
            {workspace.status === "blocked" && can(context, "workspaces.override") ? (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer font-medium">Activate by manual override</summary>
                <ActionForm
                  action={overrideActivation}
                  submitLabel="Override and activate"
                  variant="destructive"
                  confirmMessage="Activate without the configured conditions? This is audited and stays visibly marked."
                  className="mt-3"
                >
                  {hidden}
                  <div className="space-y-1">
                    <Label htmlFor="override-reason">Reason (audited, shown on the workspace)</Label>
                    <Textarea id="override-reason" name="reason" rows={2} required minLength={3} />
                  </div>
                </ActionForm>
              </details>
            ) : null}
            {can(context, "workspaces.manage") && ["active", "suspended", "blocked"].includes(workspace.status) ? (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer font-medium">Suspend, resume or close</summary>
                <ActionForm action={transitionWorkspace} submitLabel="Apply" variant="outline" className="mt-3">
                  {hidden}
                  <select name="to" className={select} aria-label="New status">
                    {workspace.status === "active" ? <option value="suspended">Suspend</option> : null}
                    {workspace.status === "suspended" ? <option value="blocked">Resume (re-evaluate)</option> : null}
                    <option value="closed">Close</option>
                  </select>
                  <Input name="reason" placeholder="Reason (audited)" required aria-label="Reason" />
                </ActionForm>
              </details>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Delivery</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {workspace.delivery_status === "not_ready" ? (
              <ul className="list-disc pl-5">
                {workspace.kickoff_blockers.map((blocker) => (
                  <li key={blocker}>{KICKOFF_BLOCKER_LABELS[blocker] ?? blocker}</li>
                ))}
              </ul>
            ) : (
              <p>{workspace.kickoff_ready_at ? `Kickoff ready since ${dateFormat.format(new Date(workspace.kickoff_ready_at))}.` : ""}</p>
            )}
            {canManage && deliveryMoves[workspace.delivery_status] && workspace.status === "active" ? (
              <ActionForm action={setDeliveryStatus} submitLabel="Update delivery" variant="outline" className="flex flex-wrap items-end gap-2 space-y-0">
                {hidden}
                <select name="to" className={select} aria-label="Delivery status">
                  {deliveryMoves[workspace.delivery_status].map((to) => (
                    <option key={to} value={to}>
                      {to.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
                <Input name="reason" placeholder="Reason (for pause or complete)" aria-label="Reason" className="w-64" />
              </ActionForm>
            ) : null}
            <div>
              <h3 className="font-medium">Team</h3>
              <ul className="mt-1 space-y-1">
                {(members.data ?? []).map((member) => (
                  <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {name(member)} {member.role === "lead" ? <span className="text-muted-foreground">(lead)</span> : null}
                    </span>
                    {can(context, "workspaces.manage") ? (
                      <ActionForm action={setWorkspaceMember} submitLabel="Remove" variant="outline">
                        {hidden}
                        <input type="hidden" name="userId" value={member.user_id} />
                        <input type="hidden" name="role" value="remove" />
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
              {can(context, "workspaces.manage") ? (
                <ActionForm action={setWorkspaceMember} submitLabel="Add to team" variant="outline" className="mt-2 flex flex-wrap items-end gap-2 space-y-0">
                  {hidden}
                  <select name="userId" className={select} aria-label="Team member">
                    {(staff.data ?? []).map((member) => (
                      <option key={member.user_id} value={member.user_id}>
                        {name(member)}
                      </option>
                    ))}
                  </select>
                  <select name="role" className={select} aria-label="Role">
                    <option value="member">Member</option>
                    <option value="lead">Lead</option>
                  </select>
                </ActionForm>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Milestones</CardTitle>
          <CardDescription>Client-visible milestones appear in the client&apos;s workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y text-sm">
            {(milestones.data ?? []).map((milestone) => (
              <li key={milestone.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{milestone.title}</span>
                  {milestone.client_visible ? null : <span className="text-muted-foreground"> (internal)</span>}
                  {milestone.due_at ? <span className="block text-xs text-muted-foreground">Target {dateFormat.format(new Date(milestone.due_at))}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={milestone.status} />
                  {canManage && milestone.status !== "done" ? (
                    <ActionForm action={saveMilestone} submitLabel="Mark done" variant="outline">
                      {hidden}
                      <input type="hidden" name="milestoneId" value={milestone.id} />
                      <input type="hidden" name="title" value={milestone.title} />
                      <input type="hidden" name="description" value={milestone.description ?? ""} />
                      <input type="hidden" name="dueDate" value={milestone.due_at ?? ""} />
                      <input type="hidden" name="status" value="done" />
                      {milestone.client_visible ? <input type="hidden" name="clientVisible" value="on" /> : null}
                    </ActionForm>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {canManage ? (
            <ActionForm action={saveMilestone} submitLabel="Add milestone" variant="outline" className="grid gap-3 space-y-0 sm:grid-cols-4 sm:items-end">
              {hidden}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ms-title">Milestone</Label>
                <Input id="ms-title" name="title" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ms-due">Target date</Label>
                <Input id="ms-due" name="dueDate" type="date" />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" name="clientVisible" defaultChecked /> Visible to client
              </label>
            </ActionForm>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tasks</CardTitle>
          <CardDescription>Owners move their own tasks; leads and operations manage the plan. Changes are audited.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y text-sm">
            {(tasks.data ?? []).map((task) => {
              const mine = task.owner_user_id === context.userId;
              const overdue = task.due_at && isPast(task.due_at) && !["done", "cancelled"].includes(task.status);
              return (
                <li key={task.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{task.title}</span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {task.owner_user_id ? (memberName.get(task.owner_user_id) ?? "Former member") : "Unassigned"}
                        {task.priority !== "normal" ? ` · ${task.priority}` : ""}
                        {task.client_visible ? " · shared with client" : ""}
                      </span>
                      {task.due_at ? (
                        <span className={overdue ? "block text-xs text-destructive" : "block text-xs text-muted-foreground"}>
                          {overdue ? "Overdue · " : "Due "}
                          {dateFormat.format(new Date(task.due_at))}
                        </span>
                      ) : null}
                      {task.internal_notes ? <span className="block text-xs text-muted-foreground">Internal: {task.internal_notes}</span> : null}
                      {task.completion_evidence ? <span className="block text-xs">Evidence: {task.completion_evidence}</span> : null}
                    </span>
                    <StatusBadge status={task.status} />
                  </div>
                  {canManage || mine ? (
                    <div className="flex flex-wrap gap-2">
                      {(NEXT_TASK_STATUS[task.status] ?? []).map((move) => (
                        <ActionForm key={move.to} action={updateTaskStatus} submitLabel={move.label} variant="outline" className="flex items-end gap-2 space-y-0">
                          {hidden}
                          <input type="hidden" name="taskId" value={task.id} />
                          <input type="hidden" name="status" value={move.to} />
                          {move.to === "done" ? <Input name="evidence" placeholder="Evidence (link or note)" aria-label="Completion evidence" className="w-56" /> : null}
                        </ActionForm>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canManage ? (
            <ActionForm action={saveTask} submitLabel="Add task" variant="outline" className="grid gap-3 space-y-0 sm:grid-cols-3 sm:items-end">
              {hidden}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="task-title">Task</Label>
                <Input id="task-title" name="title" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="task-owner">Owner</Label>
                <select id="task-owner" name="ownerId" className={`${select} w-full`}>
                  <option value="">Unassigned</option>
                  {(members.data ?? []).map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {name(member)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="task-due">Due</Label>
                <Input id="task-due" name="dueDate" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="task-priority">Priority</Label>
                <select id="task-priority" name="priority" defaultValue="normal" className={`${select} w-full`}>
                  {["low", "normal", "high", "urgent"].map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="task-milestone">Milestone</Label>
                <select id="task-milestone" name="milestoneId" className={`${select} w-full`}>
                  <option value="">None</option>
                  {(milestones.data ?? []).map((milestone) => (
                    <option key={milestone.id} value={milestone.id}>
                      {milestone.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="task-dependency">Depends on</Label>
                <select id="task-dependency" name="dependencyId" className={`${select} w-full`}>
                  <option value="">Nothing</option>
                  {(tasks.data ?? []).map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="task-notes">Internal notes (never shown to the client)</Label>
                <Input id="task-notes" name="internalNotes" />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" name="clientVisible" /> Share title with client
              </label>
            </ActionForm>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Updates and notes</CardTitle>
          <CardDescription>Client updates appear in the client&apos;s workspace. Internal notes never do.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ActionForm action={postWorkspaceUpdate} submitLabel="Post" variant="outline">
            {hidden}
            <Textarea name="body" rows={2} required aria-label="Update text" />
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="visibility" value="internal" defaultChecked /> Internal note
              </label>
              {canManage ? (
                <label className="flex items-center gap-2">
                  <input type="radio" name="visibility" value="client" /> Update for the client
                </label>
              ) : null}
            </div>
          </ActionForm>
          <ol className="space-y-3 text-sm">
            {(updates.data ?? []).map((update) => (
              <li key={update.id} className={update.visibility === "client" ? "border-l-2 border-brand pl-3" : "border-l-2 pl-3"}>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {update.visibility === "client" ? "Client-visible" : "Internal"} · {dateTime.format(new Date(update.created_at))}
                </p>
                <p className="whitespace-pre-wrap">{update.body}</p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
