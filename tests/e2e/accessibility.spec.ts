import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { hasAuthEnv, signInContext } from "./support/auth";

/**
 * AT-033: automated WCAG checks (axe) on the client journey and dashboard, at
 * desktop and mobile widths. Serious and critical violations fail the build.
 * Also checks the Content Security Policy is present and nothing on the page
 * is blocked by it.
 */
async function audit(page: Page, path: string) {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to (load|execute)/i.test(message.text())) {
      violations.push(`CSP: ${message.text().slice(0, 200)}`);
    }
  });
  const response = await page.goto(path);
  expect(response?.headers()["content-security-policy"], path).toContain("nonce-");
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  for (const violation of results.violations.filter((item) => item.impact === "serious" || item.impact === "critical")) {
    violations.push(`${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(", ")})`);
  }
  expect(violations, path).toEqual([]);
}

test("public pages are accessible", async ({ page }) => {
  for (const path of ["/login", `/i/${"x".repeat(43)}`]) await audit(page, path);
});

test.describe("signed-in pages", () => {
  test.skip(!hasAuthEnv, "needs Supabase dev credentials");

  test("client portal pages are accessible", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext();
    await signInContext(context, "p3-client-a+clientos@example.com", baseURL!);
    const page = await context.newPage();
    for (const path of ["/portal", "/portal/book", "/portal/onboarding", "/portal/workspace"]) await audit(page, path);
    await context.close();
  });

  test("dashboard pages are accessible", async ({ browser, baseURL }) => {
    test.setTimeout(120_000); // seven full audits
    const context = await browser.newContext();
    await signInContext(context, "p2-ceo+clientos@example.com", baseURL!);
    const page = await context.newPage();
    for (const path of ["/dashboard", "/dashboard/prospects", "/dashboard/proposals", "/dashboard/meetings", "/dashboard/contracts", "/dashboard/billing", "/dashboard/security"]) {
      await audit(page, path);
    }
    await context.close();
  });
});
