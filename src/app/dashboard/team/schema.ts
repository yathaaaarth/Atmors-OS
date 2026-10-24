import { z } from "zod";

export const MEMBER_ROLES = ["ceo", "cto_coo", "delivery"] as const;
export const MEMBER_STATUSES = ["active", "suspended", "revoked"] as const;

export const updateMembershipSchema = z.object({
  membershipId: z.uuid(),
  role: z.enum(MEMBER_ROLES),
  status: z.enum(MEMBER_STATUSES),
  reason: z.string().trim().min(3, "Give a short reason for the audit log.").max(2000),
});

export type UpdateMembershipValues = z.infer<typeof updateMembershipSchema>;
