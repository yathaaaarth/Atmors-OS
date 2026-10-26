"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type ChatReply = {
  conversationId: string | null;
  answer: string;
  grounded: boolean;
  sources: { kind: string; title: string }[];
  needsHuman: boolean;
  status: string;
  handoffActionId: string | null;
  taskActionId: string | null;
  proposedTask: { title: string; detail: string } | null;
  followUpDraft: string | null;
  provider: string;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: { message: string; correlation_id: string } };

type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; reply: ChatReply; actionDone?: string };

/**
 * Assistant chat. Answers come only from approved, authorized information;
 * anything consequential (talking to a person, creating a task) happens only
 * when the user clicks to confirm (AT-029).
 */
export function AssistantChat({
  title,
  notice,
  suggestions,
  hiddenFields,
  ask,
  confirm,
  confirmLabels = { handoff: "Yes, pass this to my Atmors contact", task: "Create this task" },
}: {
  title: string;
  notice: string;
  suggestions: string[];
  hiddenFields: Record<string, string>;
  ask: (formData: FormData) => Promise<Result<ChatReply>>;
  confirm?: (formData: FormData) => Promise<Result<null>>;
  confirmLabels?: { handoff: string; task: string };
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function send(question: string) {
    const text = question.trim();
    if (text.length < 2 || pending) return;
    setError(null);
    setTurns((current) => [...current, { role: "user", text }]);
    setDraft("");
    startTransition(async () => {
      const form = new FormData();
      for (const [name, value] of Object.entries(hiddenFields)) form.set(name, value);
      form.set("question", text);
      if (conversationId) form.set("conversationId", conversationId);
      const result = await ask(form);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (result.data.conversationId) setConversationId(result.data.conversationId);
      setTurns((current) => [...current, { role: "assistant", reply: result.data }]);
    });
  }

  function confirmAction(index: number, actionId: string, kind: "handoff" | "task") {
    if (!confirm) return;
    startTransition(async () => {
      const form = new FormData();
      for (const [name, value] of Object.entries(hiddenFields)) form.set(name, value);
      form.set("actionId", actionId);
      form.set("kind", kind);
      const result = await confirm(form);
      setTurns((current) =>
        current.map((turn, position) =>
          position === index && turn.role === "assistant"
            ? { ...turn, actionDone: result.ok ? (kind === "handoff" ? "Passed to your Atmors contact." : "Task created.") : result.error.message }
            : turn,
        ),
      );
    });
  }

  return (
    <section aria-labelledby="assistant-title" className="space-y-4 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <h2 id="assistant-title" className="font-heading text-lg font-semibold">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">{notice}</p>
      </div>

      <ol aria-live="polite" className="space-y-3">
        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <li key={index} className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="sr-only">You asked: </span>
              {turn.text}
            </li>
          ) : (
            <li key={index} className="max-w-[95%] space-y-2 rounded-lg border px-3 py-2 text-sm">
              <p className="whitespace-pre-wrap">{turn.reply.answer}</p>
              {turn.reply.grounded && turn.reply.sources.length > 0 ? (
                <p className="text-xs text-muted-foreground">From: {turn.reply.sources.map((source) => source.title).join("; ")}</p>
              ) : null}
              {turn.reply.followUpDraft ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium">Draft follow-up (review and send it yourself)</p>
                  <pre className="whitespace-pre-wrap rounded bg-muted p-2 font-sans text-xs">{turn.reply.followUpDraft}</pre>
                </div>
              ) : null}
              {turn.actionDone ? (
                <p role="status" className="text-xs font-medium">
                  {turn.actionDone}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {turn.reply.handoffActionId && confirm ? (
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => confirmAction(index, turn.reply.handoffActionId!, "handoff")}>
                      {confirmLabels.handoff}
                    </Button>
                  ) : null}
                  {turn.reply.taskActionId && turn.reply.proposedTask && confirm ? (
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => confirmAction(index, turn.reply.taskActionId!, "task")}>
                      {confirmLabels.task}: {turn.reply.proposedTask.title}
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          ),
        )}
        {pending ? (
          <li className="text-sm text-muted-foreground" role="status">
            Thinking…
          </li>
        ) : null}
      </ol>

      {turns.length === 0 ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <Button key={suggestion} type="button" size="sm" variant="outline" onClick={() => send(suggestion)} disabled={pending}>
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
        className="space-y-2"
      >
        <Label htmlFor="assistant-question">Your question</Label>
        <Textarea
          id="assistant-question"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          maxLength={1000}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
        />
        <Button type="submit" disabled={pending || draft.trim().length < 2}>
          Ask
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
