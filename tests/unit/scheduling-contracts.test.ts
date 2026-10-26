import { describe, expect, it } from "vitest";

import { activationPolicySchema, describeBlockingReason, describeDue, legalIdentitySchema } from "@/modules/contracts/schema";
import { formatMeetingTime, groupSlotsByDay, isValidTimeZone, weeklyWindowSchema } from "@/modules/scheduling/schema";

describe("scheduling helpers", () => {
  // 18:30 UTC on 26 Oct is midnight on 27 Oct in India.
  const slots = [
    { start_at: "2026-10-26T18:00:00Z", end_at: "2026-10-26T18:30:00Z" },
    { start_at: "2026-10-26T18:30:00Z", end_at: "2026-10-26T19:00:00Z" },
  ];

  it("groups slots by the viewer's calendar day, not UTC", () => {
    expect(groupSlotsByDay(slots, "UTC").map((group) => group.slots.length)).toEqual([2]);
    expect(groupSlotsByDay(slots, "Asia/Kolkata").map((group) => group.key)).toEqual(["2026-10-26", "2026-10-27"]);
  });

  it("formats meeting times with the zone named", () => {
    const label = formatMeetingTime(slots[0].start_at, slots[0].end_at, "Asia/Kolkata");
    expect(label).toContain("11:30");
    expect(label).toContain("(Asia/Kolkata)");
  });

  it("validates timezones and weekly windows", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(weeklyWindowSchema.safeParse({ day: 1, start: "09:00", end: "17:00" }).success).toBe(true);
    expect(weeklyWindowSchema.safeParse({ day: 1, start: "17:00", end: "09:00" }).success).toBe(false);
    expect(weeklyWindowSchema.safeParse({ day: 8, start: "09:00", end: "10:00" }).success).toBe(false);
  });
});

describe("contract helpers", () => {
  it("normalizes the legal identity", () => {
    const parsed = legalIdentitySchema.parse({
      client_legal_name: " Acme Pvt Ltd ",
      client_address: "12 MG Road, Bengaluru",
      client_tax_id: "29abcde1234f1z5",
      signer_name: "Asha",
      signer_email: "Asha@Acme.TEST",
    });
    expect(parsed).toMatchObject({ client_legal_name: "Acme Pvt Ltd", client_tax_id: "29ABCDE1234F1Z5", signer_email: "asha@acme.test" });
    expect(legalIdentitySchema.safeParse({ ...parsed, signer_email: "not-an-email" }).success).toBe(false);
  });

  it("accepts only the documented activation policy shape", () => {
    const policy = {
      required_contract_state: "executed",
      required_payment_items: [0],
      required_onboarding_state: "not_required",
      required_manual_review: false,
    };
    expect(activationPolicySchema.safeParse(policy).success).toBe(true);
    expect(activationPolicySchema.safeParse({ ...policy, required_contract_state: "sent" }).success).toBe(false);
  });

  it("explains blocking reasons in plain language", () => {
    expect(describeBlockingReason("payment_item_unpaid:0", ["Deposit"])).toBe("“Deposit” not yet paid");
    expect(describeBlockingReason("payment_item_unpaid:3")).toBe("Instalment 4 not yet paid");
    expect(describeBlockingReason("contract_not_executed")).toBe("Agreement not yet executed");
  });

  it("describes due rules", () => {
    expect(describeDue({ due_rule: "on_date", due_date: "2026-12-01", milestone: null })).toBe("Due 2026-12-01");
    expect(describeDue({ due_rule: "on_signing", due_date: null, milestone: null })).toBe("Due on signing");
  });
});
