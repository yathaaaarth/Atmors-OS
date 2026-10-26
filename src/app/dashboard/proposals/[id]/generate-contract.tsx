import Link from "next/link";

import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ScheduleItem } from "@/modules/proposals/money";
import type { MemberContext } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { generateContract } from "../../contracts/actions";

const COUNTRIES: [string, string][] = [
  ["IN", "India"], ["US", "United States"], ["GB", "United Kingdom"], ["AE", "United Arab Emirates"], ["SG", "Singapore"],
  ["AU", "Australia"], ["CA", "Canada"], ["DE", "Germany"], ["FR", "France"], ["NL", "Netherlands"], ["IE", "Ireland"],
  ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["NZ", "New Zealand"], ["ZA", "South Africa"], ["SE", "Sweden"], ["CH", "Switzerland"],
  ["ES", "Spain"], ["IT", "Italy"], ["JP", "Japan"], ["HK", "Hong Kong"], ["MY", "Malaysia"], ["IL", "Israel"],
];

/**
 * Agreement step for an accepted proposal: links to existing agreements, or
 * the form that generates one from the exact accepted version (AT-012).
 */
export async function GenerateContract({
  context,
  proposalId,
  schedule,
  prospect,
}: {
  context: MemberContext;
  proposalId: string;
  schedule: ScheduleItem[];
  prospect: { name: string; company: string | null; email: string | null };
}) {
  const supabase = await createSupabaseServerClient();
  const [contracts, templates, members, grants] = await Promise.all([
    supabase.from("contracts").select("id, title, status, supersedes_contract_id").eq("proposal_id", proposalId).order("created_at"),
    supabase.from("contract_templates").select("id, name, version, jurisdiction_review_status").eq("organization_id", context.organizationId).eq("active", true),
    supabase.from("organization_memberships").select("user_id, role, profiles(display_name, email)").eq("organization_id", context.organizationId).eq("status", "active"),
    supabase.from("role_permissions").select("role").eq("permission_key", "contracts.manage").eq("allowed", true),
  ]);
  for (const result of [contracts, templates, members, grants]) {
    if (result.error) throw fromPostgrestError(result.error);
  }
  const live = (contracts.data ?? []).filter((contract) => !["voided", "declined", "expired"].includes(contract.status));
  const signingRoles = new Set((grants.data ?? []).map((grant) => grant.role));
  const signers = (members.data ?? []).filter((member) => signingRoles.has(member.role));

  return (
    <div className="space-y-4">
      {(contracts.data ?? []).length > 0 ? (
        <ul className="space-y-1">
          {(contracts.data ?? []).map((contract) => (
            <li key={contract.id} className="flex flex-wrap items-center gap-2">
              <Link href={`/dashboard/contracts/${contract.id}`} className="underline underline-offset-4">
                {contract.title}
              </Link>
              <StatusBadge status={contract.status} />
            </li>
          ))}
        </ul>
      ) : null}

      {live.length === 0 ? (
        <details className="rounded-md border p-3" open>
          <summary className="cursor-pointer font-medium">Generate the agreement</summary>
          <ActionForm action={generateContract} submitLabel="Generate agreement draft" className="mt-3">
            <input type="hidden" name="proposalId" value={proposalId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="legal-name">Client&apos;s registered legal name</Label>
                <Input id="legal-name" name="client_legal_name" defaultValue={prospect.company ?? ""} required />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="legal-address">Registered address</Label>
                <Textarea id="legal-address" name="client_address" rows={2} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="legal-country">Client&apos;s country</Label>
                <select id="legal-country" name="client_country" defaultValue="IN" className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {COUNTRIES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">Outside India, invoices are marked as export of services.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="legal-tax">GSTIN, VAT or tax ID (optional)</Label>
                <Input id="legal-tax" name="client_tax_id" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="legal-signer">Client signer&apos;s name</Label>
                <Input id="legal-signer" name="signer_name" defaultValue={prospect.name} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="legal-email">Client signer&apos;s email</Label>
                <Input id="legal-email" name="signer_email" type="email" defaultValue={prospect.email ?? ""} required />
                <p className="text-xs text-muted-foreground">Must be the invited contact or another client with portal access.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="countersigner">Signs for Atmors</Label>
                <select id="countersigner" name="countersignerId" defaultValue={context.userId} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {signers.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.profiles?.display_name || member.profiles?.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="template">Template</Label>
                <select id="template" name="templateId" className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {(templates.data ?? []).map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} v{template.version}
                      {template.jurisdiction_review_status !== "approved" ? " (legal review pending)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Workspace activation needs (this agreement only)</legend>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="requireExecuted" defaultChecked /> Executed agreement
              </label>
              {schedule.map((item, index) => (
                <label key={`${item.label}-${index}`} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="requiredItem"
                    value={index}
                    defaultChecked={index === 0 && (item.due === "on_acceptance" || item.due === "on_signing")}
                  />
                  “{item.label}” paid
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input type="checkbox" name="requireOnboarding" /> Onboarding approved
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="requireReview" /> Manual review by operations
              </label>
            </fieldset>
          </ActionForm>
        </details>
      ) : null}
    </div>
  );
}
