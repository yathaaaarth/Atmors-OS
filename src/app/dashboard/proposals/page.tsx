import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge } from "@/components/status-badge";
import { formatMoney } from "@/modules/proposals/money";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "Proposals" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export default async function ProposalsPage() {
  const access = await memberPageAccess("/dashboard/proposals");
  if (!access.allowed) return <AccessDenied />;

  const supabase = await createSupabaseServerClient();
  const { data: proposals, error } = await supabase
    .from("proposals")
    .select("id, title, status, sent_at, updated_at, prospects(name, company), proposal_versions!proposals_current_version_fkey(version_number, total_minor, currency, valid_until)")
    .eq("organization_id", access.context.organizationId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw fromPostgrestError(error);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Proposals</h1>
        <p className="text-sm text-muted-foreground">Start a proposal from a prospect&apos;s page.</p>
      </header>
      {proposals && proposals.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card">
          {proposals.map((proposal) => {
            const version = proposal.proposal_versions;
            return (
              <li key={proposal.id}>
                <Link
                  href={`/dashboard/proposals/${proposal.id}`}
                  className="grid gap-1 p-4 hover:bg-muted/50 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-4"
                >
                  <span>
                    <span className="font-medium">{proposal.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {proposal.prospects?.company ?? proposal.prospects?.name}
                      {proposal.sent_at ? ` · sent ${dateTime.format(new Date(proposal.sent_at))}` : ""}
                    </span>
                  </span>
                  {version ? (
                    <span className="text-sm tabular-nums text-muted-foreground">
                      v{version.version_number} · {formatMoney(version.total_minor, version.currency)}
                    </span>
                  ) : (
                    <span />
                  )}
                  <StatusBadge status={proposal.status} />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No proposals you can see yet.</p>
      )}
    </div>
  );
}
