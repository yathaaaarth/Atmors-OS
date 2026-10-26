import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCsp } from "@/lib/csp";
import { decideMfa } from "@/server/auth/mfa";
import { TEMPLATE_KEYS, renderEmail } from "@/server/notifications/templates";

describe("content security policy", () => {
  it("requires the request nonce for scripts and forbids framing and plugins", () => {
    const csp = buildCsp("abc123", { dev: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(buildCsp("x", { dev: true })).toContain("'unsafe-eval'");
  });
});

describe("staff MFA decision", () => {
  it("lets AAL2 sessions in, challenges enrolled members and enforces enrollment only when required", () => {
    expect(decideMfa("aal2", "aal2", true)).toBe("ok");
    expect(decideMfa("aal1", "aal2", false)).toBe("challenge");
    expect(decideMfa("aal1", "aal1", true)).toBe("enroll");
    expect(decideMfa("aal1", "aal1", false)).toBe("ok");
  });
});

describe("email templates", () => {
  it("renders every template with a same-site link and no payment or contract details", () => {
    for (const key of TEMPLATE_KEYS) {
      const email = renderEmail(key, { title: "Retainer", invoice_number: "INV-1", label: "Deposit", path: "/portal/x", start_at: "2026-11-02T05:00:00Z", purpose: "commercial", client_name: "Acme" }, "https://app.atmors.test");
      expect(email, key).not.toBeNull();
      expect(email!.text).toContain("https://app.atmors.test/portal/x");
      expect(email!.text).not.toMatch(/₹|INR\s?\d|\b\d{4,}\.\d{2}\b/);
    }
  });

  it("never turns a payload into an off-site link", () => {
    expect(renderEmail("contract_ready", { path: "https://evil.test/phish" }, "https://app.atmors.test")!.text).toContain("https://app.atmors.test/portal");
    expect(renderEmail("contract_ready", { path: "//evil.test" }, "https://app.atmors.test")!.text).not.toContain("evil.test");
    expect(renderEmail("unknown_template", {}, "https://app.atmors.test")).toBeNull();
  });
});

describe("cron authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed without a configured secret and rejects wrong tokens", async () => {
    const { assertCronRequest } = await import("@/server/cron");
    const request = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as never;
    vi.stubEnv("CRON_SECRET", "");
    expect(() => assertCronRequest(request("Bearer anything"))).toThrow();
    vi.stubEnv("CRON_SECRET", "s".repeat(32));
    expect(() => assertCronRequest(request("Bearer wrong"))).toThrow();
    expect(() => assertCronRequest(request())).toThrow();
    expect(() => assertCronRequest(request(`Bearer ${"s".repeat(32)}`))).not.toThrow();
  });
});

describe("email adapter", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "Atmors <hello@atmors.test>");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
  });

  it("sends with the outbox key as the provider idempotency key and classifies failures", async () => {
    const { emailProvider } = await import("@/server/notifications/email");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    expect(await emailProvider().send({ to: "a@b.test", subject: "s", text: "t", idempotencyKey: "invoice_issued:1" })).toEqual({ ok: true, messageId: "msg_1" });
    expect(fetchMock.mock.calls[0][1].headers["idempotency-key"]).toBe("invoice_issued:1");

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 422 }));
    expect(await emailProvider().send({ to: "bad", subject: "s", text: "t", idempotencyKey: "k" })).toMatchObject({ ok: false, permanent: true });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    expect(await emailProvider().send({ to: "a@b.test", subject: "s", text: "t", idempotencyKey: "k" })).toMatchObject({ ok: false, permanent: false });
    fetchMock.mockRejectedValueOnce(new Error("network"));
    expect(await emailProvider().send({ to: "a@b.test", subject: "s", text: "t", idempotencyKey: "k" })).toMatchObject({ ok: false, permanent: false });
  });
});
