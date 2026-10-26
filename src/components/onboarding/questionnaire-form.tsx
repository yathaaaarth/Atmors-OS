"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { answersFromForm, isQuestionVisible, type Answers, type Question } from "@/modules/onboarding/schema";

type State =
  | { ok: true; data: { status: string; submitted: boolean } }
  | { ok: false; error: { message: string; field_errors?: Record<string, string[]>; correlation_id: string } }
  | null;

function Field({ question, value }: { question: Question; value: unknown }) {
  const id = `q-${question.key}`;
  const name = `q_${question.key}`;
  const label = (
    <span>
      {question.label}
      {question.required ? <span aria-hidden> *</span> : <span className="text-muted-foreground"> (optional)</span>}
    </span>
  );
  const help = question.help ? <p className="text-xs text-muted-foreground">{question.help}</p> : null;

  if (question.type === "boolean" || question.type === "single_choice" || question.type === "multi_choice") {
    const options = question.type === "boolean" ? ["yes", "no"] : (question.options ?? []);
    const selected = (option: string) =>
      question.type === "boolean"
        ? value === (option === "yes")
        : Array.isArray(value)
          ? value.includes(option)
          : value === option;
    return (
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{label}</legend>
        {help}
        <div className="flex flex-wrap gap-3">
          {options.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type={question.type === "multi_choice" ? "checkbox" : "radio"}
                name={name}
                value={option}
                defaultChecked={selected(option)}
                required={question.required && question.type !== "multi_choice"}
              />
              {question.type === "boolean" ? (option === "yes" ? "Yes" : "No") : option}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  const common = { id, name, defaultValue: value === undefined ? undefined : String(value), "aria-describedby": help ? `${id}-help` : undefined };
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {question.help ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {question.help}
        </p>
      ) : null}
      {question.type === "long_text" ? (
        <Textarea {...common} rows={4} maxLength={question.max_length ?? 10000} />
      ) : (
        <Input
          {...common}
          type={{ url: "url", email: "email", number: "number", date: "date" }[question.type as string] ?? "text"}
          maxLength={question.type === "number" ? undefined : (question.max_length ?? 2000)}
        />
      )}
    </div>
  );
}

/**
 * Typed questionnaire with conditional follow-ups. Progress can be saved at
 * any time; "Submit" creates a new, immutable revision for review.
 */
export function QuestionnaireForm({
  questions,
  initial,
  action,
}: {
  questions: Question[];
  initial: Answers;
  action: (state: State, formData: FormData) => Promise<State>;
}) {
  const [answers, setAnswers] = useState<Answers>(initial);
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form
      action={formAction}
      onChange={(event) => setAnswers(answersFromForm(questions, new FormData(event.currentTarget)))}
      className="space-y-6"
      noValidate
    >
      {questions.map((question) => (
        <div key={question.key} hidden={!isQuestionVisible(question, answers)}>
          <Field question={question} value={initial[question.key]} />
        </div>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="intent" value="submit" disabled={pending}>
          {pending ? "Saving…" : "Submit for review"}
        </Button>
        <Button type="submit" name="intent" value="draft" variant="outline" disabled={pending}>
          Save and finish later
        </Button>
      </div>
      {state?.ok ? (
        <p role="status" className="text-sm text-success">
          {state.data.submitted ? "Submitted. Atmors will review it and let you know if anything is missing." : "Progress saved."}
        </p>
      ) : null}
      {state && !state.ok ? (
        <div role="alert" className="text-sm text-destructive">
          <p>{state.error.message}</p>
          {state.error.field_errors?.answers ? <p>{state.error.field_errors.answers.join(" ")}</p> : null}
        </div>
      ) : null}
    </form>
  );
}
