import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { clientWorkspaceSchema } from "@/modules/onboarding/schema";
import { getSessionUser } from "@/server/auth/session";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "Workspace" };

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

const STATUS_COPY = {
  setting_up: "We're getting things ready. Your workspace opens once the agreed start conditions are met.",
  active: "Your workspace is active.",
  suspended: "Your workspace is paused. Your Atmors contact will explain next steps.",
  closed: "This engagement has finished. Thank you for working with Atmors.",
} as const;

/** The client's view of delivery: milestones, shared tasks and updates only (PRD §5.8). */
export default async function PortalWorkspacePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/portal/workspace");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_workspace");
  if (error) throw fromPostgrestError(error);
  const back = (
    <Link href="/portal" className="text-sm text-muted-foreground underline underline-offset-4">
      ← Your portal
    </Link>
  );
  if (!data) {
    return (
      <div className="space-y-4">
        {back}
        <p className="rounded-lg border p-4 text-sm">Your workspace will appear here once your agreement is signed.</p>
      </div>
    );
  }
  const workspace = clientWorkspaceSchema.parse(data);
  const team = workspace.team.filter((member) => member.name);

  return (
    <div className="space-y-6">
      {back}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{workspace.client_name} workspace</h1>
          <StatusBadge status={workspace.status === "setting_up" ? "pending" : workspace.status} />
        </div>
        <p className="text-sm text-muted-foreground">{STATUS_COPY[workspace.status]}</p>
        {team.length > 0 ? (
          <p className="text-sm">
            Your team: {team.map((member) => `${member.name}${member.role === "lead" ? " (lead)" : ""}`).join(", ")}
          </p>
        ) : null}
      </header>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-heading text-lg font-semibold">Milestones</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {workspace.milestones.length === 0 ? (
            <p className="text-sm text-muted-foreground">Milestones will appear here once your plan is set.</p>
          ) : (
            <ol className="space-y-3 text-sm">
              {workspace.milestones.map((milestone) => (
                <li key={milestone.id} className="flex flex-wrap items-start justify-between gap-2 border-l-2 pl-3">
                  <span>
                    <span className="font-medium">{milestone.title}</span>
                    {milestone.description ? <span className="block text-muted-foreground">{milestone.description}</span> : null}
                    {milestone.due_at ? <span className="block text-xs text-muted-foreground">Target {dateFormat.format(new Date(milestone.due_at))}</span> : null}
                  </span>
                  <StatusBadge status={milestone.status} />
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {workspace.tasks.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Shared tasks</h2>
            </CardTitle>
            <CardDescription>Work items Atmors has shared with you.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {workspace.tasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {task.title}
                    {task.due_at ? <span className="block text-xs text-muted-foreground">Due {dateFormat.format(new Date(task.due_at))}</span> : null}
                  </span>
                  <StatusBadge status={task.status} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-heading text-lg font-semibold">Updates</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {workspace.updates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No updates yet.</p>
          ) : (
            <ol className="space-y-3 text-sm">
              {workspace.updates.map((update, index) => (
                <li key={index} className="border-l-2 pl-3">
                  <p className="whitespace-pre-wrap">{update.body}</p>
                  <p className="text-xs text-muted-foreground">{dateFormat.format(new Date(update.created_at))}</p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
