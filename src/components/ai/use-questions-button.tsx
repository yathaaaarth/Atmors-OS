"use client";

import { Button } from "@/components/ui/button";

/** Copies the strategist's draft questions into the review form for the reviewer to edit. */
export function UseQuestionsButton({ text, textareaId, radioValue }: { text: string; textareaId: string; radioValue: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.value = text;
          textarea.focus();
        }
        const radio = document.querySelector<HTMLInputElement>(`input[type=radio][value="${radioValue}"]`);
        if (radio) radio.checked = true;
      }}
    >
      Copy into the review form
    </Button>
  );
}
