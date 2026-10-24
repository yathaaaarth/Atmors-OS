import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { can, ROLE_LABELS } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

import { MemberEditor } from "./member-editor";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const access = await memberPageAccess("/dashboard/team", "members.read");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;

  const supabase = await createSupabaseServerClient();
  const { data: members, error } = await supabase
    .from("organization_memberships")
    .select("id, role, status, user_id, profiles(display_name, email)")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: true });
  if (error) throw fromPostgrestError(error);

  const canManage = can(context, "members.manage");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Roles grant permissions; record-level access is checked on every request. Every change is audited.
        </p>
      </header>
      <ul className="space-y-3">
        {(members ?? []).map((member) => {
          const name = member.profiles?.display_name || member.profiles?.email || "Unnamed member";
          const isSelf = member.user_id === context.userId;
          const editableStatus = member.status === "invited" ? null : member.status;
          return (
            <li key={member.id}>
              <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">
                      {name}
                      {isSelf ? <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span> : null}
                    </CardTitle>
                    {member.profiles?.email ? (
                      <p className="text-sm text-muted-foreground">{member.profiles.email}</p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="secondary">{ROLE_LABELS[member.role]}</Badge>
                    <Badge variant={member.status === "active" ? "outline" : "destructive"}>{member.status}</Badge>
                  </div>
                </CardHeader>
                {canManage && !isSelf && editableStatus ? (
                  <CardContent>
                    <MemberEditor
                      membershipId={member.id}
                      role={member.role}
                      status={editableStatus}
                      memberName={name}
                    />
                  </CardContent>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
