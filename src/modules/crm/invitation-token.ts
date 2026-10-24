import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, URL-safe. Only the SHA-256 hash is stored (PRD §5.1). */
export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Shape check before hashing, so obviously bogus paths never reach the database. */
export function isPlausibleInvitationToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export type InvitationState = "created" | "sent" | "opened" | "redeemed" | "expired" | "revoked";

/** Mirror of private.invitation_state for staff display. */
export function invitationState(
  invitation: {
    revoked_at: string | null;
    redeemed_at: string | null;
    expires_at: string;
    opened_at: string | null;
    sent_at: string | null;
  },
  now: Date = new Date(),
): InvitationState {
  if (invitation.revoked_at) return "revoked";
  if (invitation.redeemed_at) return "redeemed";
  if (new Date(invitation.expires_at) <= now) return "expired";
  if (invitation.opened_at) return "opened";
  if (invitation.sent_at) return "sent";
  return "created";
}
