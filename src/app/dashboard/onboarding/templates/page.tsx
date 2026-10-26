import type { Metadata } from "next";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { QUESTION_TYPES } from "@/modules/onboarding/schema";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import { saveQuestionnaire } from "../actions";

export const metadata: Metadata = { title: "Questionnaires" };

export default async function QuestionnairesPage() {
  const access = await memberPageAccess("/dashboard/onboarding/templates", "onboarding.manage");
  if (!access.allowed) return <AccessDenied />;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("questionnaire_templates")
    .select("id, key, version, name, questions, active, created_at")
    .eq("organization_id", access.context.organizationId)
    .order("version", { ascending: false });
  if (error) throw fromPostgrestError(error);
  const latest = data?.find((row) => row.active) ?? data?.[0];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <Link href="/dashboard/onboarding" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Onboarding
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Questionnaires</h1>
        <p className="text-sm text-muted-foreground">
          Versioned and immutable. A client keeps the version they started with; new onboardings use the active version.
        </p>
      </header>
      <ul className="space-y-2 text-sm">
        {(data ?? []).map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <span className="font-medium">{row.name}</span> v{row.version} · {(row.questions as unknown[]).length} questions
            {row.active ? <Badge>Active</Badge> : <Badge variant="outline">Inactive</Badge>}
          </li>
        ))}
      </ul>
      <Card>
        <CardHeader>
          <CardTitle>New version</CardTitle>
          <CardDescription>
            JSON array of questions: key, label, type ({QUESTION_TYPES.join(", ")}), required, and optionally help, options,
            max_length and show_if {"{ question, equals }"} (follow-ups may only depend on earlier questions).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveQuestionnaire} submitLabel="Save new version" successMessage="Saved.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="q-key">Key</Label>
                <Input id="q-key" name="key" defaultValue={latest?.key ?? "client-onboarding"} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="q-name">Name</Label>
                <Input id="q-name" name="name" defaultValue={latest?.name ?? "Client onboarding"} required />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="q-json">Questions (JSON)</Label>
              <Textarea id="q-json" name="questions" rows={20} className="font-mono text-xs" defaultValue={JSON.stringify(latest?.questions ?? [], null, 2)} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="activate" defaultChecked /> Make this the active version
            </label>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
