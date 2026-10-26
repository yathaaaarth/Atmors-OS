import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";
import { saveKnowledge, setKnowledgeStatus } from "./actions";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgePage() {
  const access = await memberPageAccess("/dashboard/knowledge", "knowledge.manage");
  if (!access.allowed) return <AccessDenied />;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("knowledge_documents")
    .select("*")
    .eq("organization_id", access.context.organizationId)
    .order("audience")
    .order("title");
  if (error) throw fromPostgrestError(error);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Approved knowledge</h1>
        <p className="text-sm text-muted-foreground">
          The assistants answer only from approved entries: client FAQ for the proposal assistant, internal procedures for the
          copilot. Editing an approved entry sends it back for approval.
        </p>
      </header>

      <ul className="space-y-3">
        {(data ?? []).map((doc) => (
          <li key={doc.id}>
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {doc.title}
                  <StatusBadge status={doc.status === "approved" ? "approved" : doc.status === "retired" ? "withdrawn" : "draft"} />
                  <span className="text-xs font-normal text-muted-foreground">
                    {doc.audience === "client" ? "Client FAQ" : "Internal procedure"} · v{doc.version}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <details>
                  <summary className="cursor-pointer text-sm">Edit</summary>
                  <ActionForm action={saveKnowledge} submitLabel="Save (needs approval again)" variant="outline" className="mt-2">
                    <input type="hidden" name="id" value={doc.id} />
                    <input type="hidden" name="audience" value={doc.audience} />
                    <Input name="title" defaultValue={doc.title} aria-label="Title" required />
                    <Textarea name="body" defaultValue={doc.body} rows={6} aria-label="Content" required />
                  </ActionForm>
                </details>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{doc.body}</p>
                <div className="flex gap-2">
                  {doc.status !== "approved" ? (
                    <ActionForm action={setKnowledgeStatus} submitLabel="Approve" variant="outline">
                      <input type="hidden" name="id" value={doc.id} />
                      <input type="hidden" name="status" value="approved" />
                    </ActionForm>
                  ) : null}
                  {doc.status !== "retired" ? (
                    <ActionForm action={setKnowledgeStatus} submitLabel="Retire" variant="outline">
                      <input type="hidden" name="id" value={doc.id} />
                      <input type="hidden" name="status" value="retired" />
                    </ActionForm>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <Card>
        <CardHeader>
          <CardTitle>New entry</CardTitle>
          <CardDescription>Write facts you are happy for the assistant to state. Keep each entry to one topic.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveKnowledge} submitLabel="Save draft" successMessage="Saved as a draft. Approve it to make it available.">
            <div className="space-y-1">
              <Label htmlFor="kb-title">Title</Label>
              <Input id="kb-title" name="title" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kb-audience">Audience</Label>
              <select id="kb-audience" name="audience" className="h-9 rounded-md border bg-background px-2 text-sm">
                <option value="client">Client FAQ</option>
                <option value="internal">Internal procedure</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="kb-body">Content</Label>
              <Textarea id="kb-body" name="body" rows={6} required />
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
