import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { Card, CardContent } from "@/components/ui/card";
import { can } from "@/server/authorization/permissions";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import { ProspectForm } from "../prospect-form";

export const metadata: Metadata = { title: "New prospect" };

export default async function NewProspectPage() {
  const access = await memberPageAccess("/dashboard/prospects/new");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!can(context, "prospects.write") && !can(context, "prospects.create")) return <AccessDenied />;

  let owners: { id: string; name: string }[] | undefined;
  if (can(context, "prospects.write")) {
    const supabase = await createSupabaseServerClient();
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
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">New prospect</h1>
      <Card>
        <CardContent className="pt-6">
          <ProspectForm owners={owners} defaults={{ owner_user_id: context.userId }} />
        </CardContent>
      </Card>
    </div>
  );
}
