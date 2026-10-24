import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge, statusLabel } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isPast } from "@/lib/time";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "Prospects" };

const STATUSES = ["new", "contacted", "engaged", "proposal_sent", "converted", "declined", "disqualified", "archived"] as const;
type Status = (typeof STATUSES)[number];

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

export default async function ProspectsPage(props: PageProps<"/dashboard/prospects">) {
  const access = await memberPageAccess("/dashboard/prospects");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;

  const params = await props.searchParams;
  const status = typeof params.status === "string" && (STATUSES as readonly string[]).includes(params.status)
    ? (params.status as Status)
    : undefined;
  const mine = params.mine === "1";
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";

  // RLS limits rows to what this member may see; filters only narrow further.
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("prospects")
    .select("id, name, company, status, next_action_at, owner_user_id, target_service")
    .eq("organization_id", context.organizationId)
    .order("next_action_at", { ascending: true, nullsFirst: false })
    .limit(200);
  if (status) query = query.eq("status", status);
  else query = query.not("status", "in", "(archived,disqualified)");
  if (mine) query = query.eq("owner_user_id", context.userId);
  if (q) {
    const pattern = `%${q.replace(/[%_,()\\]/g, "")}%`;
    query = query.or(`name.ilike.${pattern},company.ilike.${pattern},email.ilike.${pattern}`);
  }
  const { data: prospects, error } = await query;
  if (error) throw fromPostgrestError(error);

  const ownerIds = [...new Set((prospects ?? []).map((row) => row.owner_user_id))];
  const { data: owners } = ownerIds.length
    ? await supabase.from("profiles").select("id, display_name, email").in("id", ownerIds)
    : { data: [] };
  const ownerName = new Map((owners ?? []).map((owner) => [owner.id, owner.display_name || owner.email || "—"]));
  const canCreate = can(context, "prospects.write") || can(context, "prospects.create");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Prospects</h1>
          <p className="text-sm text-muted-foreground">Sorted by next follow-up. Overdue follow-ups are flagged.</p>
        </div>
        {canCreate ? (
          <Button asChild>
            <Link href="/dashboard/prospects/new">New prospect</Link>
          </Button>
        ) : null}
      </header>

      <form className="flex flex-wrap items-end gap-3" role="search">
        <div className="space-y-1">
          <Label htmlFor="q">Search</Label>
          <Input id="q" name="q" defaultValue={q} placeholder="Name, company or email" className="w-56" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ""}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value="">Active (not archived)</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {statusLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex h-8 items-center gap-2 text-sm">
          <input type="checkbox" name="mine" value="1" defaultChecked={mine} /> Only mine
        </label>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      {prospects && prospects.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card">
          {prospects.map((prospect) => {
            const overdue = isPast(prospect.next_action_at);
            return (
              <li key={prospect.id}>
                <Link
                  href={`/dashboard/prospects/${prospect.id}`}
                  className="grid gap-1 p-4 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:grid-cols-[1fr_auto_10rem] sm:items-center sm:gap-4"
                >
                  <span>
                    <span className="font-medium">{prospect.name}</span>
                    {prospect.company ? <span className="text-muted-foreground"> · {prospect.company}</span> : null}
                    <span className="block text-xs text-muted-foreground">
                      {ownerName.get(prospect.owner_user_id) ?? "—"}
                      {prospect.target_service ? ` · ${prospect.target_service}` : ""}
                    </span>
                  </span>
                  <StatusBadge status={prospect.status} />
                  <span className={overdue ? "text-sm font-medium text-destructive" : "text-sm text-muted-foreground"}>
                    {prospect.next_action_at
                      ? `${overdue ? "Overdue: " : ""}${dateFormatter.format(new Date(prospect.next_action_at))}`
                      : "No follow-up set"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No prospects match. {canCreate ? "Create one to get started." : ""}
        </p>
      )}
    </div>
  );
}
