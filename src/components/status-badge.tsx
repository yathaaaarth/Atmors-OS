import { Badge } from "@/components/ui/badge";

const LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  proposal_sent: "Proposal sent",
  converted: "Converted",
  declined: "Declined",
  disqualified: "Disqualified",
  archived: "Archived",
  draft: "Draft",
  internal_review: "Awaiting approval",
  pending_approval: "Awaiting approval",
  approved: "Approved",
  sent: "Sent",
  viewed: "Viewed",
  negotiation: "Changes requested",
  accepted: "Accepted",
  expired: "Expired",
  withdrawn: "Withdrawn",
  superseded: "Superseded",
  permission_requested: "Permission requested",
  published: "Published",
  rejected: "Rejected",
  created: "Not sent",
  opened: "Opened",
  redeemed: "Linked to account",
  revoked: "Revoked",
  preparing: "Being prepared",
};

const ATTENTION = new Set(["negotiation", "internal_review", "pending_approval", "expired", "permission_requested"]);
const NEGATIVE = new Set(["declined", "disqualified", "withdrawn", "rejected", "revoked"]);

/** Status is always shown as text; colour only reinforces it (PRD §12). */
export function StatusBadge({ status }: { status: string }) {
  const variant = NEGATIVE.has(status) ? "destructive" : ATTENTION.has(status) ? "secondary" : "outline";
  return <Badge variant={variant}>{LABELS[status] ?? status.replaceAll("_", " ")}</Badge>;
}

export function statusLabel(status: string): string {
  return LABELS[status] ?? status.replaceAll("_", " ");
}
