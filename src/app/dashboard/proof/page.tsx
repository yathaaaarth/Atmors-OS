import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "Proof library" };

export default async function ProofLibraryPage() {
  const access = await memberPageAccess("/dashboard/proof", "proof.read");
  if (!access.allowed) return <AccessDenied />;

  const supabase = await createSupabaseServerClient();
  const { data: assets, error } = await supabase
    .from("proof_assets")
    .select("id, kind, title, company_name, publication_status, permission_expires_on, updated_at")
    .eq("organization_id", access.context.organizationId)
    .order("updated_at", { ascending: false });
  if (error) throw fromPostgrestError(error);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Proof library</h1>
          <p className="text-sm text-muted-foreground">
            Only approved or published proof with valid permission can appear in proposals.
          </p>
        </div>
        {can(access.context, "proof.manage") ? (
          <Button asChild>
            <Link href="/dashboard/proof/new">Add proof</Link>
          </Button>
        ) : null}
      </header>
      {assets && assets.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card">
          {assets.map((asset) => (
            <li key={asset.id}>
              <Link
                href={`/dashboard/proof/${asset.id}`}
                className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-muted/50"
              >
                <span>
                  <span className="font-medium">{asset.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {asset.kind === "case_study" ? "Case study" : "Testimonial"}
                    {asset.company_name ? ` · ${asset.company_name}` : ""}
                    {asset.permission_expires_on ? ` · permission until ${asset.permission_expires_on}` : ""}
                  </span>
                </span>
                <StatusBadge status={asset.publication_status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No proof recorded yet.</p>
      )}
    </div>
  );
}
