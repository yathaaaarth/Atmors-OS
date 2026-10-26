import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ActionForm } from "@/components/action-form";
import { AssetUploader } from "@/components/onboarding/asset-uploader";
import { QuestionnaireForm } from "@/components/onboarding/questionnaire-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/modules/onboarding/files";
import { clientOnboardingSchema, formatAnswer } from "@/modules/onboarding/schema";
import { getSessionUser } from "@/server/auth/session";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { confirmAccessGrant, removeAsset, saveOnboarding } from "./actions";

export const metadata: Metadata = { title: "Onboarding" };

const STATUS_COPY: Record<string, string> = {
  not_started: "Tell us about your business so we can plan your work. You can save and come back any time.",
  in_progress: "Your progress is saved. Submit when you're ready.",
  submitted: "Thanks! Atmors is reviewing your answers.",
  resubmitted: "Thanks for the update. Atmors is reviewing it.",
  needs_information: "Atmors needs a little more information. See the notes below, update your answers and submit again.",
  approved: "Your onboarding is approved. Thank you!",
};

export default async function PortalOnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/portal/onboarding");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_onboarding");
  if (error) throw fromPostgrestError(error);

  if (!data) {
    return (
      <div className="space-y-4">
        <Link href="/portal" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Your portal
        </Link>
        <p className="rounded-lg border p-4 text-sm">Onboarding opens once your agreement is in place. Atmors will let you know.</p>
      </div>
    );
  }
  const onboarding = clientOnboardingSchema.parse(data);
  const editable = ["not_started", "in_progress", "needs_information"].includes(onboarding.status);
  const questionByKey = new Map(onboarding.questions.map((question) => [question.key, question]));

  return (
    <div className="space-y-6">
      <Link href="/portal" className="text-sm text-muted-foreground underline underline-offset-4">
        ← Your portal
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Onboarding</h1>
          <StatusBadge status={onboarding.status} />
        </div>
        <p className="text-sm text-muted-foreground">{STATUS_COPY[onboarding.status]}</p>
      </header>

      {onboarding.info_requests.length > 0 ? (
        <Card role="alert" className="border-amber-500/50">
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">What Atmors needs</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {onboarding.info_requests.map((request, index) => (
                <li key={index}>
                  {request.question_key && questionByKey.get(request.question_key) ? (
                    <span className="font-medium">{questionByKey.get(request.question_key)!.label}: </span>
                  ) : null}
                  {request.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-heading text-lg font-semibold">Questionnaire</h2>
          </CardTitle>
          <CardDescription>Questions marked * are required. Follow-up questions appear when they apply.</CardDescription>
        </CardHeader>
        <CardContent>
          {editable ? (
            <QuestionnaireForm questions={onboarding.questions} initial={onboarding.draft_answers} action={saveOnboarding} />
          ) : (
            <dl className="space-y-3 text-sm">
              {onboarding.questions
                .filter((question) => question.key in onboarding.submitted_answers)
                .map((question) => (
                  <div key={question.key}>
                    <dt className="font-medium">{question.label}</dt>
                    <dd className="whitespace-pre-wrap text-muted-foreground">{formatAnswer(question, onboarding.submitted_answers[question.key])}</dd>
                  </div>
                ))}
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-heading text-lg font-semibold">Files</h2>
          </CardTitle>
          <CardDescription>Logos, brand guides, past content. Files are private to you and your Atmors team.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {onboarding.assets.length > 0 ? (
            <ul className="divide-y text-sm">
              {onboarding.assets.map((asset) => (
                <li key={asset.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <a href={`/api/assets/${asset.id}`} className="underline underline-offset-4">
                    {asset.filename}
                  </a>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    {formatBytes(asset.size_bytes)}
                    <ActionForm action={removeAsset} submitLabel="Remove" variant="outline" confirmMessage={`Remove ${asset.filename}?`}>
                      <input type="hidden" name="assetId" value={asset.id} />
                    </ActionForm>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No files yet.</p>
          )}
          <AssetUploader />
        </CardContent>
      </Card>

      {onboarding.access_grants.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-heading text-lg font-semibold">Access we need</h2>
            </CardTitle>
            <CardDescription>
              Grant access through each platform&apos;s own sharing settings. Never send us your password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4 text-sm">
              {onboarding.access_grants.map((grant) => (
                <li key={grant.id} className="space-y-2 rounded-md border p-3">
                  <p className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {grant.platform}: {grant.requested_scope}
                    </span>
                    <StatusBadge status={grant.status} />
                  </p>
                  {grant.instructions ? <p className="whitespace-pre-wrap text-muted-foreground">{grant.instructions}</p> : null}
                  {grant.status === "requested" || grant.status === "declined" ? (
                    <ActionForm action={confirmAccessGrant} submitLabel="I've granted access" variant="outline">
                      <input type="hidden" name="grantId" value={grant.id} />
                      <Input name="note" placeholder="Optional note, for example which account you added" aria-label="Note" />
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
