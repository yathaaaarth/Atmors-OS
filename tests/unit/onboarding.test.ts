import { describe, expect, it } from "vitest";

import { checkUpload, MAX_UPLOAD_BYTES } from "@/modules/onboarding/files";
import { answersFromForm, isQuestionVisible, type Question } from "@/modules/onboarding/schema";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = new TextEncoder().encode("%PDF-1.7\n...");

describe("upload validation (AT-022)", () => {
  it("accepts files whose type, extension and content agree", () => {
    expect(checkUpload("logo.png", "image/png", PNG)).toEqual({ ok: true, contentType: "image/png" });
    expect(checkUpload("brief.pdf", "application/pdf", PDF)).toEqual({ ok: true, contentType: "application/pdf" });
    expect(checkUpload("list.csv", "application/vnd.ms-excel", new TextEncoder().encode("a,b\n1,2"))).toEqual({ ok: true, contentType: "text/csv" });
  });

  it("rejects disguised, scriptable, empty and oversized files", () => {
    expect(checkUpload("logo.png", "image/png", PDF).ok).toBe(false); // PDF bytes named .png
    expect(checkUpload("evil.pdf", "application/pdf", new TextEncoder().encode("<script>alert(1)</script>")).ok).toBe(false);
    expect(checkUpload("logo.svg", "image/svg+xml", new TextEncoder().encode("<svg/>")).ok).toBe(false);
    expect(checkUpload("page.html", "text/html", new TextEncoder().encode("<html>")).ok).toBe(false);
    expect(checkUpload("tool.exe", "application/octet-stream", new Uint8Array([0x4d, 0x5a])).ok).toBe(false);
    expect(checkUpload("notes.txt", "text/plain", new Uint8Array([0x68, 0, 0x69])).ok).toBe(false); // binary posing as text
    expect(checkUpload("empty.pdf", "application/pdf", new Uint8Array()).ok).toBe(false);
    expect(checkUpload("big.pdf", "application/pdf", new Uint8Array(MAX_UPLOAD_BYTES + 1)).ok).toBe(false);
  });
});

describe("questionnaire answers", () => {
  const questions: Question[] = [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "has_guide", label: "Guide?", type: "boolean", required: true },
    { key: "guide_notes", label: "Notes", type: "long_text", required: false, show_if: { question: "has_guide", equals: true } },
    { key: "channels", label: "Channels", type: "multi_choice", required: true, options: ["A", "B"] },
    { key: "count", label: "Count", type: "number", required: false },
  ];

  it("types answers and drops hidden follow-ups", () => {
    const form = new FormData();
    form.set("q_name", "  Acme ");
    form.set("q_has_guide", "no");
    form.set("q_guide_notes", "hidden");
    form.append("q_channels", "A");
    form.append("q_channels", "B");
    form.set("q_count", "3");
    form.set("q_unknown", "ignored");
    expect(answersFromForm(questions, form)).toEqual({ name: "Acme", has_guide: false, channels: ["A", "B"], count: 3 });
    form.set("q_has_guide", "yes");
    expect(answersFromForm(questions, form)).toMatchObject({ has_guide: true, guide_notes: "hidden" });
  });

  it("evaluates follow-up visibility like the database", () => {
    expect(isQuestionVisible(questions[2], { has_guide: true })).toBe(true);
    expect(isQuestionVisible(questions[2], { has_guide: false })).toBe(false);
    expect(isQuestionVisible({ ...questions[2], show_if: { question: "channels", equals: "B" } }, { channels: ["A", "B"] })).toBe(true);
  });
});
