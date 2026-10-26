import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { daysAgoIso } from "@/lib/time";
import { aiLimits, aiProvider } from "@/server/ai/registry";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";

export const metadata: Metadata = { title: "AI usage" };

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

const OUTCOME_LABELS: Record<string, string> = {
  ok: "Answered",
  fallback: "Said it didn't know",
  policy_blocked: "Blocked by policy",
  error: "Provider error",
};

/** Usage, cost drivers and outcomes for review (PRD §1 AI usefulness, §6 telemetry). */
export default async function AiUsagePage() {
  const access = await memberPageAccess("/dashboard/ai", "ai.monitor");
  if (!access.allowed) return <AccessDenied />;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("ai_messages")
    .select("id, created_at, content, validation_status, policy_flags, error_category, provider, model, input_tokens, output_tokens, latency_ms, ai_conversations!inner(assistant, actor_type)")
    .eq("organization_id", access.context.organizationId)
    .eq("role", "assistant")
    .gte("created_at", daysAgoIso(7))
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw fromPostgrestError(error);
  const rows = data ?? [];
  const tokens = rows.reduce((sum, row) => sum + (row.input_tokens ?? 0) + (row.output_tokens ?? 0), 0);
  const count = (status: string) => rows.filter((row) => row.validation_status === status).length;
  const provider = aiProvider();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">AI usage</h1>
        <p className="text-sm text-muted-foreground">
          Provider: {provider.id} ({provider.model}). Limits: {aiLimits.actorDailyMessages} questions per person per day,{" "}
          {aiLimits.orgDailyTokens.toLocaleString("en-IN")} tokens per day, {aiLimits.timeoutMs / 1000}s timeout.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-5">
        {[
          ["Answers (7 days)", rows.length],
          ["Answered", count("ok")],
          ["Said it didn't know", count("fallback")],
          ["Blocked by policy", count("policy_blocked")],
          ["Provider errors", count("error")],
        ].map(([label, value]) => (
          <Card key={label as string}>
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">Tokens in the last 7 days: {tokens.toLocaleString("en-IN")}.</p>

      <Card>
        <CardHeader>
          <CardTitle>Recent answers</CardTitle>
          <CardDescription>What the assistant said, and whether policy changed it. Review blocked and fallback answers to improve the knowledge base.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Assistant</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Answer</TableHead>
                <TableHead className="text-right">Tokens / ms</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-xs">{dateTime.format(new Date(row.created_at))}</TableCell>
                  <TableCell className="text-xs">
                    {row.ai_conversations.assistant} ({row.ai_conversations.actor_type})
                  </TableCell>
                  <TableCell className="text-xs">
                    <StatusBadge status={row.validation_status === "ok" ? "processed" : row.validation_status === "error" ? "failed" : "quarantined"} />
                    <span className="block">{OUTCOME_LABELS[row.validation_status ?? ""] ?? row.validation_status}</span>
                    {row.policy_flags.length ? <span className="block text-muted-foreground">{row.policy_flags.join(", ")}</span> : null}
                    {row.error_category ? <span className="block text-muted-foreground">{row.error_category}</span> : null}
                  </TableCell>
                  <TableCell className="max-w-md truncate text-xs" title={row.content}>
                    {row.content}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {(row.input_tokens ?? 0) + (row.output_tokens ?? 0)} / {row.latency_ms ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
