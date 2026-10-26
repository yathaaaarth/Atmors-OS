import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import { saveTemplate, setTemplateState } from "../actions";

export const metadata: Metadata = { title: "Agreement templates" };

const PLACEHOLDERS = [
  "organization_name", "client_legal_name", "client_address", "client_tax_line", "proposal_title", "version_number",
  "accepted_on", "terms_hash", "summary", "scope", "deliverables", "timeline", "dependencies", "assumptions",
  "exclusions", "fees", "subtotal", "discount", "tax", "total", "currency", "payment_schedule", "terms",
  "signer_name", "signer_email",
];

const REVIEW_LABELS: Record<string, string> = {
  pending: "Legal review pending",
  approved: "Legally approved",
  rejected: "Rejected in review",
};

export default async function TemplatesPage() {
  const access = await memberPageAccess("/dashboard/contracts/templates", "contracts.templates");
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;

  const supabase = await createSupabaseServerClient();
  const { data: templates, error } = await supabase
    .from("contract_templates")
    .select("id, key, version, name, body, active, jurisdiction_review_status, review_note, template_hash, created_at")
    .eq("organization_id", context.organizationId)
    .order("key")
    .order("version", { ascending: false });
  if (error) throw fromPostgrestError(error);
  const latest = templates?.[0];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <Link href="/dashboard/contracts" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Agreements
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Agreement templates</h1>
        <p className="text-sm text-muted-foreground">
          Templates are versioned and immutable; saving creates a new version. Agreements record the template version and hash
          they were generated from.
        </p>
      </header>

      <ul className="space-y-4">
        {(templates ?? []).map((template) => (
          <li key={template.id}>
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {template.name} <span className="text-sm font-normal text-muted-foreground">v{template.version}</span>
                  {template.active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}
                  <Badge variant={template.jurisdiction_review_status === "approved" ? "outline" : "secondary"}>
                    {REVIEW_LABELS[template.jurisdiction_review_status]}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Key <code>{template.key}</code> · hash <code>{template.template_hash.slice(0, 16)}</code>
                  {template.review_note ? ` · ${template.review_note}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <details>
                  <summary className="cursor-pointer text-sm font-medium">Show text</summary>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-sans text-sm">{template.body}</pre>
                </details>
                <ActionForm action={setTemplateState} submitLabel="Update" variant="outline" className="flex flex-wrap items-end gap-3 space-y-0">
                  <input type="hidden" name="templateId" value={template.id} />
                  <label className="flex items-center gap-2 pb-2 text-sm">
                    <input type="checkbox" name="active" defaultChecked={template.active} /> Active
                  </label>
                  <div className="space-y-1">
                    <Label htmlFor={`review-${template.id}`}>Legal review</Label>
                    <select
                      id={`review-${template.id}`}
                      name="reviewStatus"
                      defaultValue={template.jurisdiction_review_status}
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="pending">Pending</option>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </div>
                  <div className="min-w-60 flex-1 space-y-1">
                    <Label htmlFor={`note-${template.id}`}>Note (required when review status changes)</Label>
                    <Input id={`note-${template.id}`} name="note" />
                  </div>
                </ActionForm>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <Card>
        <CardHeader>
          <CardTitle>New version</CardTitle>
          <CardDescription>
            Placeholders: {PLACEHOLDERS.map((name) => `{{${name}}}`).join(", ")}. Unknown placeholders are rejected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveTemplate} submitLabel="Save new version" successMessage="Saved. Activate it above when it is ready.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="template-key">Key</Label>
                <Input id="template-key" name="key" defaultValue={latest?.key ?? "services-agreement"} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="template-name">Name</Label>
                <Input id="template-name" name="name" defaultValue={latest?.name} required />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="template-body">Text</Label>
              <Textarea id="template-body" name="body" rows={18} defaultValue={latest?.body} required className="font-mono text-xs" />
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
