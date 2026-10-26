import type { Question } from "@/modules/onboarding/schema";
import type { ClientProposal } from "@/modules/proposals/client-view";
import { formatMoney, scheduleAmounts } from "@/modules/proposals/money";

import type { ContextItem } from "./types";

/**
 * Build model context from projections the caller is already authorized to
 * see. Clients get exactly their own client-safe proposal projection, approved
 * proof on it, and approved client FAQ (AT-028 by construction).
 */
export function proposalContext(view: ClientProposal, faq: { id: string; title: string; body: string }[]): ContextItem[] {
  const items: ContextItem[] = [];
  const version = view.version;
  if (version) {
    const content = version.content;
    const list = (values: string[] | undefined) => (values?.length ? values.map((value) => `- ${value}`).join("\n") : "None listed.");
    items.push(
      { id: "proposal:overview", kind: "proposal", title: "Summary and scope", text: `${content.summary ?? ""}\n\nScope: ${content.scope ?? ""}` },
      { id: "proposal:deliverables", kind: "proposal", title: "Deliverables", text: list(content.deliverables) },
      { id: "proposal:timeline", kind: "proposal", title: "Timeline and dependencies", text: `${content.timeline || "No timeline given."}\nDependencies:\n${list(content.dependencies)}` },
      { id: "proposal:assumptions", kind: "proposal", title: "Assumptions", text: list(content.assumptions) },
      { id: "proposal:exclusions", kind: "proposal", title: "Exclusions (not included)", text: list(content.exclusions) },
      { id: "proposal:terms", kind: "proposal", title: "Terms", text: content.terms || "No additional terms." },
    );
    const money = (minor: number) => formatMoney(minor, version.currency);
    const lines = version.line_items
      .map((line) => `- ${line.title}: ${line.quantity} x ${money(line.unit_amount_minor)}${line.discount_minor ? `, discount ${money(line.discount_minor)}` : ""}, tax ${line.tax_rate_bps / 100}%, total ${money(line.total_minor)}`)
      .join("\n");
    const amounts = scheduleAmounts(version.payment_schedule, version.total_minor);
    const schedule = version.payment_schedule
      .map((item, index) => {
        const due = item.due === "on_date" ? `due ${item.due_date}` : item.due === "on_milestone" ? `due at ${item.milestone}` : item.due === "on_signing" ? "due on signing" : "due on acceptance";
        return `- ${item.label}: ${money(amounts[index])} (${due})`;
      })
      .join("\n");
    items.push({
      id: "proposal:pricing",
      kind: "pricing",
      title: `Pricing (version ${version.version_number})`,
      text: `Currency ${version.currency}.\n${lines}\nSubtotal ${money(version.subtotal_minor)}; discount ${money(version.discount_minor)}; tax ${money(version.tax_minor)}; total ${money(version.total_minor)}.\nPayment schedule:\n${schedule}\nValid until ${version.valid_until ?? "not stated"}.`,
    });
  }
  items.push({
    id: "proposal:status",
    kind: "proposal",
    title: "Where things stand",
    text: `Proposal "${view.proposal.title}" is ${view.proposal.status.replaceAll("_", " ")}. Next steps after acceptance: the agreement is sent for signature, then invoices follow the payment schedule, then onboarding.`,
  });
  for (const proof of view.proof) {
    const metrics = proof.metrics.map((metric) => `${metric.label}: ${metric.value} (${metric.kind.replace("_", " ")}, ${metric.period})`).join("; ");
    items.push({
      id: `proof:${proof.id}`,
      kind: "proof",
      title: proof.title,
      text: [proof.quote ? `"${proof.quote}" ${proof.author_name ?? ""}${proof.company_name ? `, ${proof.company_name}` : ""}` : "", proof.narrative ?? "", metrics].filter(Boolean).join("\n"),
    });
  }
  for (const doc of faq) items.push({ id: `faq:${doc.id}`, kind: "faq", title: doc.title, text: doc.body });
  return items;
}

/** Onboarding answers as context for the strategist (ids carry the question key). */
export function onboardingContext(questions: Question[], answers: Map<string, unknown>, assetNames: string[]): ContextItem[] {
  const items: ContextItem[] = [];
  for (const question of questions) {
    if (!answers.has(question.key)) continue;
    const value = answers.get(question.key);
    items.push({
      id: `answer:${question.key}`,
      kind: "answer",
      title: question.label,
      text: Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    });
  }
  const unanswered = questions.filter((question) => !answers.has(question.key)).map((question) => `${question.key}: ${question.label}`);
  if (unanswered.length) items.push({ id: "answer:_unanswered", kind: "record", title: "Questions left blank", text: unanswered.join("\n") });
  if (assetNames.length) items.push({ id: "assets", kind: "asset", title: "Uploaded files", text: assetNames.join("\n") });
  return items;
}
