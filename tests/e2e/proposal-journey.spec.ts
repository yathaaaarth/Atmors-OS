import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { hasAuthEnv, signInContext } from "./support/auth";

/**
 * Full Phase 2 journey through the real UI against the dev Supabase project:
 * staff create a prospect and proposal, issue a link; an anonymous visitor
 * reads it; the bound client accepts in the portal. Requires the fixture
 * users created by `npm run test:security`.
 */
test.describe("proposal journey", () => {
  test.skip(!hasAuthEnv, "needs Supabase dev credentials");
  test.describe.configure({ mode: "serial" });

  const CLIENT_EMAIL = "p2-client-a+clientos@example.com";
  const runId = randomUUID().slice(0, 8);
  let prospectUrl = "";
  let proposalUrl = "";
  let invitationUrl = "";

  test("CEO sees every dashboard area without errors", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    await signInContext(context, "p2-ceo+clientos@example.com", baseURL!);
    const page = await context.newPage();
    for (const [path, heading] of [
      ["/dashboard", "Work queue"],
      ["/dashboard/prospects", "Prospects"],
      ["/dashboard/proposals", "Proposals"],
      ["/dashboard/proof", "Proof library"],
      ["/dashboard/meetings", "Meetings"],
      ["/dashboard/contracts", "Agreements"],
      ["/dashboard/contracts/templates", "Agreement templates"],
      ["/dashboard/billing", "Billing"],
      ["/dashboard/team", "Team"],
      ["/dashboard/audit", "Audit log"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    }
    await context.close();
  });

  test("sales creates a prospect and a proposal through the UI", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    await signInContext(context, "p2-sales+clientos@example.com", baseURL!);
    const page = await context.newPage();

    // Least privilege: no team or audit pages for sales.
    await page.goto("/dashboard/team");
    await expect(page.getByText("You don't have access to this page")).toBeVisible();

    await page.goto("/dashboard/prospects/new");
    await page.getByLabel("Name").fill(`E2E Prospect ${runId}`);
    await page.getByLabel("Company").fill("E2E Co");
    await page.getByLabel("Email", { exact: true }).fill(`e2e-${runId}+clientos@example.com`);
    await page.getByRole("button", { name: "Create prospect" }).click();
    await expect(page).toHaveURL(/\/dashboard\/prospects\/[0-9a-f-]{36}$/);
    prospectUrl = page.url();
    await expect(page.getByRole("heading", { level: 1, name: `E2E Prospect ${runId}` })).toBeVisible();

    await page.getByLabel("Title").fill("Growth retainer");
    await page.getByRole("button", { name: "Start a proposal" }).click();
    await expect(page).toHaveURL(/\/dashboard\/proposals\/[0-9a-f-]{36}$/);
    proposalUrl = page.url();

    await page.getByLabel("Valid until").fill(new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10));
    await page.getByLabel("Summary", { exact: true }).fill("Grow qualified pipeline from LinkedIn.");
    await page.getByLabel("Scope of work").fill("Content strategy, writing and publishing.");
    await page.getByRole("button", { name: "Add line" }).click();
    await page.getByLabel("Line 1", { exact: true }).fill("Monthly content");
    await page.getByLabel("Qty", { exact: true }).fill("3");
    await page.getByLabel("Unit price").fill("50000");
    await page.getByRole("button", { name: "Add instalment" }).click();
    await page.getByLabel("Instalment", { exact: true }).fill("Deposit");
    await page.getByLabel("%", { exact: true }).fill("100");
    // Live preview uses the same arithmetic as the database: 3 × ₹50,000 + 18% GST.
    await expect(page.getByText("₹1,77,000.00").first()).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved\. Total ₹1,77,000\.00\./)).toBeVisible();

    await page.getByRole("button", { name: "Submit version" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Send version 1 to client" }).click();
    await expect(page.getByText("The client is reviewing version 1")).toBeVisible();

    await page.goto(prospectUrl);
    await page.getByLabel("Proposal to share").selectOption({ label: "Growth retainer" });
    await page.getByRole("button", { name: "Create secure link" }).click();
    const link = page.getByLabel("Invitation link");
    await expect(link).toHaveValue(/\/i\/[A-Za-z0-9_-]{43}$/);
    invitationUrl = await link.inputValue();
    await page.getByRole("button", { name: "Mark as sent" }).click();
    await expect(page.getByText("Secure invitation link sent")).toBeVisible();
    await context.close();
  });

  test("an anonymous visitor with the link sees the proposal but must verify to accept", async ({ browser }) => {
    test.skip(!invitationUrl, "depends on the previous test");
    const context = await browser.newContext();
    const page = await context.newPage();
    // Links carry NEXT_PUBLIC_SITE_URL; visit the path on whichever server is under test.
    await page.goto(new URL(invitationUrl).pathname);
    await expect(page.getByRole("heading", { level: 1, name: "Growth retainer" })).toBeVisible();
    await expect(page.getByText("₹1,77,000.00").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a secure link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept proposal" })).toHaveCount(0);

    await page.getByLabel("Ask a question").fill("Can we start next month?");
    await page.getByRole("button", { name: "Send question" }).click();
    await expect(page.getByText("Your question has been passed")).toBeVisible();
    await context.close();
  });

  test("staff see the proposal as viewed and the client's question as a follow-up", async ({ browser, baseURL }) => {
    test.skip(!proposalUrl, "depends on the previous tests");
    const context = await browser.newContext();
    await signInContext(context, "p2-sales+clientos@example.com", baseURL!);
    const page = await context.newPage();
    await page.goto(proposalUrl);
    await expect(page.getByText("Viewed").first()).toBeVisible();
    await page.goto(prospectUrl);
    await expect(page.getByText("Can we start next month?")).toBeVisible();
    await context.close();
  });

  test("the bound client accepts the exact version in the portal", async ({ browser, baseURL }) => {
    // Use the standing fixture client: invite + redeem through the API, then accept in the UI.
    const sales = await browser.newContext();
    await signInContext(sales, "p2-sales+clientos@example.com", baseURL!);
    const page = await sales.newPage();
    await page.goto("/dashboard/prospects?q=Asha");
    await page.getByRole("link", { name: /Asha Client/ }).click();
    await page.getByLabel("Title").fill(`Portal accept ${runId}`);
    await page.getByRole("button", { name: "Start a proposal" }).click();
    await expect(page).toHaveURL(/\/dashboard\/proposals\//);
    const acceptProposalUrl = page.url();
    await page.getByLabel("Valid until").fill(new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
    await page.getByLabel("Summary", { exact: true }).fill("Short engagement.");
    await page.getByLabel("Scope of work").fill("One workshop.");
    await page.getByRole("button", { name: "Add line" }).click();
    await page.getByLabel("Line 1", { exact: true }).fill("Workshop");
    await page.getByLabel("Unit price").fill("20000");
    await page.getByRole("button", { name: "Add instalment" }).click();
    await page.getByLabel("Instalment", { exact: true }).fill("Full");
    await page.getByLabel("%", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    await page.getByRole("button", { name: "Submit version" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Send version 1 to client" }).click();
    await expect(page.getByText("The client is reviewing version 1")).toBeVisible();
    await page.getByRole("link", { name: /Asha Client/ }).click();
    await page.getByLabel("Proposal to share").selectOption({ label: `Portal accept ${runId}` });
    await page.getByRole("button", { name: "Create secure link" }).click();
    const link = await page.getByLabel("Invitation link").inputValue();
    await sales.close();

    const client = await browser.newContext();
    await signInContext(client, CLIENT_EMAIL, baseURL!);
    const clientPage = await client.newPage();
    await clientPage.goto(new URL(link).pathname);
    // Already signed in as the invited email: this binds and redirects straight to the portal.
    await clientPage.getByRole("button", { name: "Email me a secure link" }).click();
    await expect(clientPage).toHaveURL(/\/portal\/proposals\/[0-9a-f-]{36}$/);
    await clientPage.getByRole("checkbox").check();
    clientPage.once("dialog", (dialog) => dialog.accept());
    await clientPage.getByRole("button", { name: "Accept proposal" }).click();
    await expect(clientPage.getByRole("heading", { name: "Accepted" })).toBeVisible();
    await client.close();

    const ceo = await browser.newContext();
    await signInContext(ceo, "p2-ceo+clientos@example.com", baseURL!);
    const ceoPage = await ceo.newPage();
    await ceoPage.goto(acceptProposalUrl);
    await expect(ceoPage.getByText(/Accepted on .* against version 1/)).toBeVisible();
    await ceoPage.goto("/dashboard");
    await expect(ceoPage.getByText(`Portal accept ${runId}`)).toBeVisible();
    await ceo.close();
  });
});
