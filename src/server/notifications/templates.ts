/**
 * Transactional email templates. They carry secure portal links, never
 * contract terms or payment details (PRD §10 email adapter).
 */

export type RenderedEmail = { subject: string; text: string };

type Payload = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");

function when(payload: Payload): string {
  const start = str(payload.start_at);
  if (!start) return "";
  const timeZone = str(payload.timezone) || "Asia/Kolkata";
  try {
    return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeStyle: "short", timeZone }).format(new Date(start)) + ` (${timeZone})`;
  } catch {
    return start;
  }
}

const TEMPLATES: Record<string, (payload: Payload) => { subject: string; body: string }> = {
  proposal_ready: (p) => ({ subject: "Your Atmors proposal is ready", body: `A new version of "${str(p.title)}" is ready for you to review.` }),
  contract_ready: (p) => ({ subject: "Your Atmors agreement is ready to sign", body: `Your agreement "${str(p.title)}" is ready. Sign in to review and sign it.` }),
  contract_executed: (p) => ({ subject: "Your Atmors agreement is signed", body: `"${str(p.title)}" has been signed by everyone. A copy is in your portal.` }),
  invoice_issued: (p) => ({ subject: `Invoice ${str(p.invoice_number)} from Atmors`, body: `Invoice ${str(p.invoice_number)} (${str(p.label)}) is ready in your portal, where you can pay securely.` }),
  payment_received: (p) => ({ subject: `Payment received for ${str(p.invoice_number)}`, body: `Thank you. We've confirmed your payment for invoice ${str(p.invoice_number)}.` }),
  invoice_overdue: (p) => ({ subject: `Invoice ${str(p.invoice_number)} is overdue`, body: `Invoice ${str(p.invoice_number)} is past its due date. You can pay it from your portal, or reply if something is wrong.` }),
  meeting_booked: (p) => ({ subject: "Your call with Atmors is booked", body: `Your ${str(p.purpose)} call is booked for ${when(p)}.` }),
  meeting_booked_host: (p) => ({ subject: "New call booked", body: `A ${str(p.purpose)} call was booked for ${when(p)}.` }),
  meeting_rescheduled: (p) => ({ subject: "Your call with Atmors has moved", body: `Your ${str(p.purpose)} call is now at ${when(p)}.` }),
  meeting_cancelled: (p) => ({ subject: "Call cancelled", body: `The ${str(p.purpose)} call at ${when(p)} has been cancelled. You can book another time from the portal.` }),
  meeting_reminder: (p) => ({ subject: "Reminder: your call with Atmors", body: `This is a reminder of your ${str(p.purpose)} call at ${when(p)}.` }),
  onboarding_needs_information: () => ({ subject: "Atmors needs a little more information", body: "Thanks for your onboarding answers. We have a few follow-up questions; you'll find them in your portal." }),
  onboarding_approved: () => ({ subject: "Your onboarding is complete", body: "Thank you. Your onboarding has been approved." }),
  workspace_active: (p) => ({ subject: "Your Atmors workspace is active", body: `The ${str(p.client_name)} workspace is now active. Your delivery team will be in touch to plan the kickoff.` }),
};

export function renderEmail(templateKey: string, payload: Payload, siteUrl: string): RenderedEmail | null {
  const template = TEMPLATES[templateKey];
  if (!template) return null;
  const { subject, body } = template(payload);
  const path = str(payload.path);
  // Only same-site relative paths become links.
  const link = path.startsWith("/") && !path.startsWith("//") ? new URL(path, siteUrl).toString() : new URL("/portal", siteUrl).toString();
  return {
    subject,
    text: `${body}\n\nOpen: ${link}\n\nIf you weren't expecting this email, reply and let us know.\n— Atmors`,
  };
}

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);
