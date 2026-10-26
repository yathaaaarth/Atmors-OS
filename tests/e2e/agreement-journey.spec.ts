import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { hasAuthEnv, signInContext } from "./support/auth";

/**
 * Phase 3 journey through the real UI against the dev Supabase project:
 * agreement generated from an accepted proposal, signed by the client in the
 * portal, countersigned, then the deposit paid through the sandbox checkout
 * with a delayed confirmation (AT-017). Also books a call from an invitation
 * link. Requires `npm run test:security` to have created the p3 fixtures and
 * ENABLE_SANDBOX_PROVIDERS=true for the server under test.
 */
test.describe("agreement and payment journey", () => {
  test.skip(!hasAuthEnv || process.env.ENABLE_SANDBOX_PROVIDERS !== "true", "needs dev credentials and sandbox providers");
  test.describe.configure({ mode: "serial" });

  const PASSWORD = process.env.TEST_USER_PASSWORD ?? "clientos-rls-fixture-Pa55!";
  const SALES = "p3-sales+clientos@example.com";
  const CEO = "p3-ceo+clientos@example.com";
  const CTO = "p3-cto+clientos@example.com";
  const DELIVERY = "p3-delivery+clientos@example.com";
  const runId = randomUUID().slice(0, 8);
  // A fresh client per run: onboarding and the workspace are one per client.
  const CLIENT = `p3-journey-${runId}+clientos@example.com`;
  const title = `Agreement journey ${runId}`;
  let proposalId = "";
  let contractUrl = "";
  let bookingToken = "";

  async function as(email: string) {
    const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw error;
    return client;
  }

  async function rpc(client: Awaited<ReturnType<typeof as>>, fn: string, args: Record<string, unknown>) {
    const { data, error } = await client.rpc(fn, { ...args, p_correlation_id: randomUUID() });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  }

  test.beforeAll(async () => {
    // An accepted proposal for the fixture client, set up through the API.
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const created = await admin.auth.admin.createUser({ email: CLIENT, password: PASSWORD, email_confirm: true });
    if (created.error) throw created.error;
    const sales = await as(SALES);
    const client = await as(CLIENT);
    const { data: org } = await sales.from("organizations").select("id").eq("slug", "p3-fixture").single();
    const prospect = await rpc(sales, "create_prospect", {
      p_organization_id: org!.id,
      p_owner_user_id: (await sales.auth.getUser()).data.user!.id,
      p_name: `Journey ${runId}`,
      p_email: CLIENT,
    });
    const proposal = await rpc(sales, "create_proposal", { p_prospect_id: prospect!.id, p_title: title, p_currency: "INR" });
    proposalId = proposal.id;
    const versionId = proposal.current_version_id;
    await rpc(sales, "save_proposal_draft", {
      p_version_id: versionId,
      p_title: title,
      p_currency: "INR",
      p_valid_until: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
      p_content: { summary: "Grow pipeline", scope: "LinkedIn content" },
      p_payment_schedule: [
        { label: "Deposit", basis: "percent", percent_bps: 5000, due: "on_signing" },
        { label: "Balance", basis: "percent", percent_bps: 5000, due: "on_milestone", milestone: "Month 1" },
      ],
      p_line_items: [{ title: "Content", quantity: 1, unit_amount_minor: 100000, tax_rate_bps: 1800 }],
    });
    await rpc(sales, "submit_proposal_version", { p_version_id: versionId });
    await rpc(sales, "send_proposal_version", { p_version_id: versionId });

    const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
    const acceptToken = randomBytes(32).toString("base64url");
    await rpc(sales, "create_invitation", { p_prospect_id: prospect!.id, p_proposal_id: proposalId, p_token_hash: hashOf(acceptToken), p_expires_in_days: 14 });
    await rpc(client, "redeem_invitation", { p_token_hash: hashOf(acceptToken) });
    const { data: version } = await client.rpc("client_proposal_view", { p_proposal_id: proposalId });
    await rpc(client, "accept_proposal", {
      p_proposal_id: proposalId,
      p_version_id: versionId,
      p_content_hash: (version as { version: { content_hash: string } }).version.content_hash,
    });

    bookingToken = randomBytes(32).toString("base64url");
    await rpc(sales, "create_invitation", { p_prospect_id: prospect!.id, p_proposal_id: null, p_token_hash: hashOf(bookingToken), p_expires_in_days: 14 });
  });

  test("the CEO generates, freezes and sends the agreement", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    await signInContext(context, CEO, baseURL!);
    const page = await context.newPage();
    await page.goto(`/dashboard/proposals/${proposalId}`);
    await page.getByLabel("Client's registered legal name").fill(`Asha Ventures ${runId} Private Limited`);
    await page.getByLabel("Registered address").fill("12 MG Road, Bengaluru 560001");
    await page.getByRole("button", { name: "Generate agreement draft" }).click();
    await expect(page).toHaveURL(/\/dashboard\/contracts\/[0-9a-f-]{36}$/);
    contractUrl = page.url();
    await expect(page.getByText(`Asha Ventures ${runId} Private Limited`).first()).toBeVisible();
    await expect(page.getByText("has not been approved by a qualified Indian legal professional")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Mark ready to send" }).click();
    await page.getByRole("button", { name: "Send for signature" }).click();
    await expect(page.getByText("Waiting for the client to sign in their portal.")).toBeVisible();
    await context.close();
  });

  test("the client signs in the portal; the CEO countersigns", async ({ browser, baseURL }) => {
    test.skip(!contractUrl, "depends on the previous test");
    const client = await browser.newContext();
    await signInContext(client, CLIENT, baseURL!);
    const page = await client.newPage();
    await page.goto("/portal");
    await page.getByRole("link", { name: new RegExp(`${title}.*Ready for your signature`) }).click();
    await expect(page.getByText(`Asha Ventures ${runId} Private Limited`).first()).toBeVisible();
    await page.getByRole("checkbox").check();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Sign agreement" }).click();
    await expect(page.getByText("You've signed. Atmors will countersign next")).toBeVisible();
    await client.close();

    const ceo = await browser.newContext();
    await signInContext(ceo, CEO, baseURL!);
    const ceoPage = await ceo.newPage();
    await ceoPage.goto(contractUrl);
    ceoPage.once("dialog", (dialog) => dialog.accept());
    await ceoPage.getByRole("button", { name: "Countersign for Atmors" }).click();
    await expect(ceoPage.getByText(/Executed .*The document and signature evidence are immutable/)).toBeVisible();
    // The deposit (due on signing) is invoiced automatically; activation waits for it.
    await expect(ceoPage.getByRole("link", { name: /^INV-/ })).toBeVisible();
    await expect(ceoPage.getByText("“Deposit” not yet paid")).toBeVisible();
    await ceo.close();
  });

  test("the client pays; the portal shows pending until the verified event arrives", async ({ browser, baseURL }) => {
    test.skip(!contractUrl, "depends on the previous tests");
    const context = await browser.newContext();
    await signInContext(context, CLIENT, baseURL!);
    const page = await context.newPage();
    await page.goto("/portal");
    await page.getByRole("link", { name: /Deposit.*₹590\.00 due/ }).click();
    await page.getByRole("button", { name: /Test checkout: pay ₹590.00/ }).click();
    await expect(page).toHaveURL(/\/portal\/pay\/sandbox\//);

    await page.getByRole("button", { name: "Pay, but delay the confirmation" }).click();
    await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible();
    await expect(page.getByRole("button", { name: /: pay / })).toHaveCount(0); // no double payment while pending

    await page.getByRole("link", { name: "Open the test checkout" }).click();
    await page.getByRole("button", { name: "Pay successfully" }).click();
    await expect(page.getByText("Payment of ₹590.00 confirmed")).toBeVisible();
    await expect(page.getByText("Paid").first()).toBeVisible();
    await context.close();

    const ceo = await browser.newContext();
    await signInContext(ceo, CEO, baseURL!);
    const ceoPage = await ceo.newPage();
    await ceoPage.goto(contractUrl);
    await expect(ceoPage.getByText("Eligible for activation")).toBeVisible();
    await ceo.close();
  });

  test("an invitation holder books a call without signing in", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/i/${bookingToken}/book`);
    await expect(page.getByRole("heading", { level: 1, name: "Proposal and pricing call" })).toBeVisible();
    await page.locator("label:has(input[name=startAt])").first().click();
    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByText("You're booked")).toBeVisible();
    await context.close();
  });

  test("the client completes onboarding with a file; operations review it and the workspace opens", async ({ browser, baseURL }) => {
    test.skip(!contractUrl, "depends on the previous tests");
    const client = await browser.newContext();
    await signInContext(client, CLIENT, baseURL!);
    const page = await client.newPage();
    await page.goto("/portal/onboarding");
    await page.getByLabel("Business or brand name").fill("Asha Ventures");
    await page.getByLabel("What do you sell, and to whom?").fill("Analytics for retailers");
    await page.getByLabel(/Who is your ideal customer/).fill("Merchandising heads");
    await page.getByLabel(/first 90 days/).fill("Three demos a month");
    await page.getByLabel("LinkedIn personal profile").check();
    await page.getByRole("group", { name: /brand or tone-of-voice/ }).getByLabel("Yes").check();
    // The conditional follow-up appears only after "Yes".
    await expect(page.getByLabel(/Please upload them below/)).toBeVisible();
    await page.getByLabel(/Describe your voice/).fill("Direct and warm");
    await page.getByLabel(/Who approves content/).fill("approver@asha.test");
    await page.getByRole("button", { name: "Save and finish later" }).click();
    await expect(page.getByText("Progress saved.")).toBeVisible();

    await page.getByLabel(/Add a file/).setInputFiles({ name: "brand-guide.txt", mimeType: "text/plain", buffer: Buffer.from("Tone: direct, warm.") });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("link", { name: "brand-guide.txt" })).toBeVisible();
    // A disguised file is refused.
    await page.getByLabel(/Add a file/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("%PDF-1.7 not a png") });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText("The file's contents don't match its type.")).toBeVisible();

    await page.getByRole("button", { name: "Submit for review" }).click();
    // The page switches to the read-only view of the submitted answers.
    await expect(page.getByText("Thanks! Atmors is reviewing your answers.")).toBeVisible();
    await client.close();

    const cto = await browser.newContext();
    await signInContext(cto, CTO, baseURL!);
    const ctoPage = await cto.newPage();
    await ctoPage.goto("/dashboard/onboarding");
    await ctoPage.getByRole("link", { name: `Journey ${runId}` }).click();
    await expect(ctoPage.getByText("Analytics for retailers")).toBeVisible();
    await ctoPage.getByRole("button", { name: "Record decision" }).click();
    await expect(ctoPage.getByText("Approved").first()).toBeVisible();
    await ctoPage.getByRole("link", { name: "workspace", exact: true }).click();
    await expect(ctoPage.getByText("Active since")).toBeVisible();
    await ctoPage.getByLabel("Team member").selectOption({ label: "P3 delivery" });
    await ctoPage.getByLabel("Role").selectOption("lead");
    await ctoPage.getByRole("button", { name: "Add to team" }).click();
    await expect(ctoPage.getByText("Kickoff ready").first()).toBeVisible();
    await ctoPage.locator("#ms-title").fill("Content strategy approved");
    await ctoPage.getByRole("button", { name: "Add milestone" }).click();
    await expect(ctoPage.getByText("Content strategy approved").first()).toBeVisible();
    await cto.close();

    const delivery = await browser.newContext();
    await signInContext(delivery, DELIVERY, baseURL!);
    const deliveryPage = await delivery.newPage();
    await deliveryPage.goto("/dashboard/workspaces");
    await expect(deliveryPage.getByRole("link", { name: `Asha Ventures ${runId} Private Limited` }).or(deliveryPage.getByRole("link", { name: `Journey ${runId}` }))).toBeVisible();
    await deliveryPage.goto("/dashboard/billing");
    await expect(deliveryPage.getByText("You don't have access to this page")).toBeVisible();
    await delivery.close();

    const back = await browser.newContext();
    await signInContext(back, CLIENT, baseURL!);
    const workspacePage = await back.newPage();
    await workspacePage.goto("/portal/workspace");
    await expect(workspacePage.getByText("Your workspace is active.", { exact: true })).toBeVisible();
    await expect(workspacePage.getByText("Content strategy approved")).toBeVisible();
    await back.close();
  });
});
