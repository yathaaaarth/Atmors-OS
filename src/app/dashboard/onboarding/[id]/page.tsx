import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { UseQuestionsButton } from "@/components/ai/use-questions-button";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/modules/onboarding/files";
import { formatAnswer, questionSchema } from "@/modules/onboarding/schema";
import { can } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../../member-page";
import { requestAccessGrant, reviewOnboarding, runAiReview, setAiNoteStatus, updateAccessGrant } from "../actions";

export const metadata: Metadata = { title: "Onboarding review" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function OnboardingReviewPage(props: PageProps<"/dashboard/onboarding/[id]">) {
  const { id } = await props.params;
  const access = await memberPageAccess(`/dashboard/onboarding/${id}`);
  if (!access.allowed) return <AccessDenied />;
  const { context } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  // RLS: reviewers always; assigned delivery staff once approved.
  const supabase = await createSupabaseServerClient();
  const { data: onboarding, error } = await supabase
    .from("onboardings")
    .select("*, questionnaire_templates(name, version, questions)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!onboarding) notFound();

  const [submissions, reviews, assets, grants, prospect, workspace, notes] = await Promise.all([
    supabase.from("onboarding_submissions").select("id, revision, submitted_at").eq("onboarding_id", id).order("revision", { ascending: false }),
    supabase.from("onboarding_reviews").select("*").eq("onboarding_id", id).order("created_at", { ascending: false }),
    supabase.from("client_assets").select("*").eq("prospect_id", onboarding.prospect_id).eq("status", "ready").order("created_at"),
    supabase.from("access_grants").select("*").eq("prospect_id", onboarding.prospect_id).order("created_at"),
    supabase.from("prospects").select("id, name, company").eq("id", onboarding.prospect_id).maybeSingle(),
    supabase.from("workspaces").select("id, client_name").eq("prospect_id", onboarding.prospect_id).maybeSingle(),
    supabase.from("onboarding_ai_notes").select("*").eq("onboarding_id", id).eq("status", "draft").order("created_at", { ascending: false }).limit(1),
  ]);
  for (const result of [submissions, reviews, assets, grants, prospect, workspace, notes]) {
    if (result.error) throw fromPostgrestError(result.error);
  }
  const revisions = submissions.data ?? [];
  const [latest, previous] = revisions;
  const { data: answerRows, error: answerError } = revisions.length
    ? await supabase.from("onboarding_answers").select("submission_id, question_key, answer_json").in("submission_id", [latest.id, previous?.id].filter(Boolean) as string[])
    : { data: [], error: null };
  if (answerError) throw fromPostgrestError(answerError);
  const answersFor = (submissionId?: string) =>
    new Map((answerRows ?? []).filter((row) => row.submission_id === submissionId).map((row) => [row.question_key, row.answer_json]));
  const latestAnswers = answersFor(latest?.id);
  const previousAnswers = answersFor(previous?.id);
  const questions = questionSchema.array().parse(onboarding.questionnaire_templates?.questions ?? []);
  const canReview = can(context, "onboarding.manage");
  const awaiting = ["submitted", "resubmitted"].includes(onboarding.status);
  const clientName = prospect.data?.company ?? prospect.data?.name ?? workspace.data?.client_name ?? "Client";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link href="/dashboard/onboarding" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Onboarding
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{clientName}</h1>
          <StatusBadge status={onboarding.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {onboarding.questionnaire_templates?.name} v{onboarding.questionnaire_templates?.version}
          {latest ? ` · revision ${latest.revision} submitted ${dateTime.format(new Date(latest.submitted_at))}` : " · not submitted yet"}
          {workspace.data ? (
            <>
              {" · "}
              <Link href={`/dashboard/workspaces/${workspace.data.id}`} className="underline underline-offset-4">
                workspace
              </Link>
            </>
          ) : null}
        </p>
      </header>

      {canReview && awaiting && latest ? (
        <Card className="border-brand/40">
          <CardHeader>
            <CardTitle>Review revision {latest.revision}</CardTitle>
            <CardDescription>Approving can activate the workspace if the agreement requires onboarding approval.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={reviewOnboarding} submitLabel="Record decision">
              <input type="hidden" name="onboardingId" value={onboarding.id} />
              <input type="hidden" name="submissionId" value={latest.id} />
              {questions.map((question) => (
                <input key={question.key} type="hidden" name="questionKeys" value={question.key} />
              ))}
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="decision" value="approved" defaultChecked /> Approve
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="decision" value="needs_information" /> Ask for more information
                </label>
              </div>
              <div className="space-y-1">
                <Label htmlFor="requests">What&apos;s missing (one item per line; start with a question key such as &quot;goals:&quot; to link it)</Label>
                <Textarea id="requests" name="requests" rows={4} />
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      {canReview && latest ? (
        <Card>
          <CardHeader>
            <CardTitle>AI review assistant</CardTitle>
            <CardDescription>
              Flags vague or missing answers and drafts questions for you. It is a suggestion stored separately; it never changes
              what the client submitted.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {(() => {
              const note = notes.data?.[0];
              if (!note) return null;
              const content = note.content as {
                flags: { question_key: string; issue: string; note: string }[];
                clarifying_questions: { question_key: string | null; question: string }[];
                brief: { business: string; audience: string; goals: string; voice: string };
                missing_assets: string[];
              };
              const requestText = content.clarifying_questions
                .map((item) => (item.question_key ? `${item.question_key}: ${item.question}` : item.question))
                .join("\n");
              return (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Draft from {note.provider} ({note.model}), {dateTime.format(new Date(note.created_at))}. AI interpretation, not client-provided.
                  </p>
                  {content.flags.length ? (
                    <ul className="list-disc pl-5">
                      {content.flags.map((flag, index) => (
                        <li key={index}>
                          <span className="font-medium">{flag.question_key}</span> ({flag.issue}): {flag.note}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No vague or missing answers flagged.</p>
                  )}
                  {content.clarifying_questions.length ? (
                    <div className="space-y-2">
                      <p className="font-medium">Draft questions</p>
                      <pre className="whitespace-pre-wrap rounded bg-muted p-2 font-sans text-xs">{requestText}</pre>
                      {awaiting ? <UseQuestionsButton text={requestText} textareaId="requests" radioValue="needs_information" /> : null}
                    </div>
                  ) : null}
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {(["business", "audience", "goals", "voice"] as const).map((key) => (
                      <div key={key}>
                        <dt className="text-xs font-medium uppercase text-muted-foreground">{key} (draft brief)</dt>
                        <dd>{content.brief[key] || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                  {content.missing_assets.length ? <p>Possibly missing: {content.missing_assets.join(", ")}</p> : null}
                  <div className="flex gap-2">
                    {(["used", "discarded"] as const).map((status) => (
                      <ActionForm key={status} action={setAiNoteStatus} submitLabel={status === "used" ? "Mark as used" : "Discard"} variant="outline">
                        <input type="hidden" name="onboardingId" value={onboarding.id} />
                        <input type="hidden" name="noteId" value={note.id} />
                        <input type="hidden" name="status" value={status} />
                      </ActionForm>
                    ))}
                  </div>
                </div>
              );
            })()}
            <ActionForm action={runAiReview} submitLabel={notes.data?.length ? "Run again" : "Review with AI"} pendingLabel="Reviewing…" variant="outline">
              <input type="hidden" name="onboardingId" value={onboarding.id} />
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Answers</CardTitle>
          <CardDescription>
            Exactly as the client submitted them.{previous ? ` Changes since revision ${previous.revision} are marked.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!latest ? (
            <p className="text-sm text-muted-foreground">Nothing submitted yet.</p>
          ) : (
            <dl className="space-y-4 text-sm">
              {questions.map((question) => {
                const value = latestAnswers.get(question.key);
                const before = previousAnswers.get(question.key);
                const changed = previous && JSON.stringify(value) !== JSON.stringify(before);
                if (value === undefined && before === undefined) return null;
                return (
                  <div key={question.key} className={changed ? "border-l-4 border-amber-500 pl-3" : ""}>
                    <dt className="font-medium">
                      {question.label} <span className="text-xs font-normal text-muted-foreground">({question.key})</span>
                      {changed ? <span className="ml-2 text-xs font-normal">Changed</span> : null}
                    </dt>
                    <dd className="whitespace-pre-wrap">{formatAnswer(question, value)}</dd>
                    {changed ? <dd className="whitespace-pre-wrap text-xs text-muted-foreground line-through">{formatAnswer(question, before)}</dd> : null}
                  </div>
                );
              })}
            </dl>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>Private. Downloads use a one-minute link and are audited.</CardDescription>
          </CardHeader>
          <CardContent>
            {(assets.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No files.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {(assets.data ?? []).map((asset) => (
                  <li key={asset.id} className="flex flex-wrap justify-between gap-2">
                    <a href={`/api/assets/${asset.id}`} className="underline underline-offset-4">
                      {asset.filename}
                    </a>
                    <span className="text-muted-foreground">{formatBytes(asset.size_bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {(reviews.data ?? []).map((review) => (
                <li key={review.id} className="border-l-2 pl-3">
                  <p className="font-medium">{review.decision === "approved" ? "Approved" : "Asked for more information"}</p>
                  {(review.reasons as { message: string }[]).map((reason, index) => (
                    <p key={index} className="text-muted-foreground">
                      {reason.message}
                    </p>
                  ))}
                  <p className="text-xs text-muted-foreground">{dateTime.format(new Date(review.created_at))}</p>
                </li>
              ))}
              {revisions.map((revision) => (
                <li key={revision.id} className="border-l-2 pl-3 text-muted-foreground">
                  Revision {revision.revision} submitted {dateTime.format(new Date(revision.submitted_at))}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Access grants</CardTitle>
          <CardDescription>Ask clients to grant access through each platform. Passwords are refused automatically.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(grants.data ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(grants.data ?? []).map((grant) => (
                <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium">{grant.platform}</span> · {grant.requested_scope}
                    {grant.client_note ? <span className="block text-muted-foreground">Client: {grant.client_note}</span> : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={grant.status} />
                    {canReview
                      ? (grant.status === "client_confirmed" || grant.status === "requested"
                          ? (["verified", "declined"] as const)
                          : grant.status === "verified"
                            ? (["revoked"] as const)
                            : grant.status === "declined"
                              ? (["requested"] as const)
                              : []
                        ).map((status) => (
                          <ActionForm key={status} action={updateAccessGrant} submitLabel={status === "requested" ? "Ask again" : status[0].toUpperCase() + status.slice(1)} variant="outline">
                            <input type="hidden" name="onboardingId" value={onboarding.id} />
                            <input type="hidden" name="grantId" value={grant.id} />
                            <input type="hidden" name="status" value={status} />
                          </ActionForm>
                        ))
                      : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {canReview ? (
            <ActionForm action={requestAccessGrant} submitLabel="Request access" variant="outline" className="grid gap-3 space-y-0 sm:grid-cols-2">
              <input type="hidden" name="onboardingId" value={onboarding.id} />
              <input type="hidden" name="prospectId" value={onboarding.prospect_id} />
              <div className="space-y-1">
                <Label htmlFor="grant-platform">Platform</Label>
                <Input id="grant-platform" name="platform" placeholder="LinkedIn company page" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="grant-scope">Access needed</Label>
                <Input id="grant-scope" name="scope" placeholder="Content admin" required />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="grant-instructions">Instructions for the client</Label>
                <Textarea id="grant-instructions" name="instructions" rows={2} />
              </div>
            </ActionForm>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
