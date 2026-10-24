import { describe, expect, it } from "vitest";

import { hashInvitationToken, generateInvitationToken, invitationState, isPlausibleInvitationToken } from "@/modules/crm/invitation-token";
import { compareVersions, type ClientVersion } from "@/modules/proposals/client-view";
import { EMPTY_LINE, editorToDraftInput, versionToEditorValues, type EditorValues } from "@/modules/proposals/editor-values";

const VERSION_ID = "00000000-0000-4000-8000-000000000001";

function baseVersion(overrides: Partial<ClientVersion> = {}): ClientVersion {
  return {
    id: VERSION_ID,
    version_number: 1,
    currency: "INR",
    valid_until: "2026-11-30",
    is_expired: false,
    content: { summary: "s", scope: "x", terms: "t" },
    payment_schedule: [{ label: "All", basis: "percent", percent_bps: 10_000, due: "on_signing" }],
    subtotal_minor: 100_000,
    discount_minor: 0,
    tax_minor: 18_000,
    total_minor: 118_000,
    line_items: [
      {
        title: "Content",
        description: null,
        quantity: 1,
        unit: null,
        unit_amount_minor: 100_000,
        discount_minor: 0,
        tax_rate_bps: 1800,
        billing_timing: "upfront",
        gross_minor: 100_000,
        net_minor: 100_000,
        tax_minor: 18_000,
        total_minor: 118_000,
      },
    ],
    content_hash: "a".repeat(64),
    change_summary: null,
    sent_at: null,
    ...overrides,
  };
}

describe("compareVersions", () => {
  it("describes price, line and section changes for the client", () => {
    const previous = baseVersion();
    const current = baseVersion({
      version_number: 2,
      total_minor: 59_000,
      content: { summary: "s", scope: "narrower", terms: "t" },
      line_items: [
        { ...previous.line_items[0], total_minor: 59_000 },
        { ...previous.line_items[0], title: "Strategy call", total_minor: 0 },
      ],
    });
    const changes = compareVersions(previous, current);
    expect(changes[0]).toMatch(/^Total changed from/);
    expect(changes.some((change) => change.startsWith("“Content” changed"))).toBe(true);
    expect(changes.some((change) => change.startsWith("Added “Strategy call”"))).toBe(true);
    expect(changes.at(-1)).toBe("Updated sections: scope.");
  });

  it("reports nothing when versions are identical", () => {
    expect(compareVersions(baseVersion(), baseVersion({ version_number: 2 }))).toEqual([]);
  });
});

describe("proposal editor conversion", () => {
  const values: EditorValues = {
    title: "Retainer",
    currency: "INR",
    validUntil: "2026-12-01",
    summary: "Summary",
    scope: "Scope",
    deliverables: "- 12 posts\n• Monthly report\n\n",
    timeline: "",
    dependencies: "",
    assumptions: "",
    exclusions: "Paid ads",
    terms: "Terms",
    lineItems: [{ ...EMPTY_LINE, title: "Content", quantity: "2.5", unitAmount: "10,000.01", discount: "0", taxPercent: "18" }],
    scheduleBasis: "percent",
    schedule: [
      { label: "Deposit", value: "50", due: "on_signing", due_date: "", milestone: "" },
      { label: "Balance", value: "50", due: "on_milestone", due_date: "", milestone: "Month 1" },
    ],
    proofIds: [],
    nonStandardTerms: false,
    marginException: false,
  };

  it("converts text money and percentages without floating point", () => {
    const result = editorToDraftInput(VERSION_ID, values);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.lineItems[0]).toMatchObject({ quantity: 2.5, unit_amount_minor: 1_000_001, tax_rate_bps: 1800 });
    expect(result.input.paymentSchedule.map((item) => (item.basis === "percent" ? item.percent_bps : 0))).toEqual([5000, 5000]);
    expect(result.input.content.deliverables).toEqual(["12 posts", "Monthly report"]);
    expect(result.input.content.exclusions).toEqual(["Paid ads"]);
  });

  it("reports unparseable amounts per line", () => {
    const result = editorToDraftInput(VERSION_ID, {
      ...values,
      lineItems: [{ ...values.lineItems[0], unitAmount: "ten" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/Line 1/);
  });

  it("round-trips through stored rows", () => {
    const result = editorToDraftInput(VERSION_ID, values);
    if (!result.ok) throw new Error("conversion failed");
    const back = versionToEditorValues(
      "Retainer",
      {
        currency: "INR",
        valid_until: "2026-12-01",
        content: result.input.content,
        payment_schedule: result.input.paymentSchedule,
        non_standard_terms: false,
        margin_exception: false,
      },
      [{ title: "Content", description: null, quantity: 2.5, unit: null, unit_amount_minor: 1_000_001, discount_minor: 0, tax_rate_bps: 1800, billing_timing: "upfront" }],
      [],
    );
    expect(back.lineItems[0]).toMatchObject({ unitAmount: "10000.01", taxPercent: "18", quantity: "2.5" });
    expect(back.schedule.map((item) => item.value)).toEqual(["50", "50"]);
    expect(editorToDraftInput(VERSION_ID, back)).toEqual(result);
  });
});

describe("invitation tokens", () => {
  it("generates 256-bit URL-safe tokens and stores only a SHA-256 hash", () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(isPlausibleInvitationToken(token)).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).not.toContain(token);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInvitationToken().token));
    expect(tokens.size).toBe(200);
  });

  it("derives state with revoked and redeemed taking precedence over expiry", () => {
    const base = { revoked_at: null, redeemed_at: null, opened_at: null, sent_at: null, expires_at: "2099-01-01T00:00:00Z" };
    expect(invitationState(base)).toBe("created");
    expect(invitationState({ ...base, sent_at: "x" })).toBe("sent");
    expect(invitationState({ ...base, opened_at: "x" })).toBe("opened");
    expect(invitationState({ ...base, expires_at: "2000-01-01T00:00:00Z" })).toBe("expired");
    expect(invitationState({ ...base, expires_at: "2000-01-01T00:00:00Z", redeemed_at: "x" })).toBe("redeemed");
    expect(invitationState({ ...base, redeemed_at: "x", revoked_at: "x" })).toBe("revoked");
  });
});
