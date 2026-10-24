import { expect, test } from "@playwright/test";

test("health endpoint responds with the envelope and a correlation id", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ data: { status: "ok" } });
  expect(response.headers()["x-correlation-id"]).toBeTruthy();
});

test("signed-out API calls get the stable error envelope", async ({ request }) => {
  const response = await request.get("/api/me");
  expect(response.status()).toBe(401);
  const body = await response.json();
  expect(body.error).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
  expect(body.error.correlation_id).toBeTruthy();
});

test("dashboard redirects signed-out visitors to sign in and keeps the destination", async ({ page }) => {
  await page.goto("/dashboard/team");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard%2Fteam/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("portal redirects signed-out visitors to sign in", async ({ page }) => {
  await page.goto("/portal");
  await expect(page).toHaveURL(/\/login\?next=%2Fportal/);
});

test("sign-in form validates email accessibly and is keyboard operable", async ({ page }) => {
  await page.goto("/login");
  const email = page.getByLabel("Work email");
  await email.focus();
  await email.fill("not-an-email");
  await page.keyboard.press("Enter");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAccessibleDescription(/valid email/);
  await expect(page.locator("#email-error")).toHaveAttribute("role", "alert");
});

test("unsafe next parameters are not reflected into the form", async ({ page }) => {
  await page.goto("/login?next=https://evil.example");
  await expect(page.locator('input[name="next"]')).toHaveValue("/dashboard");
});

test("baseline security headers are present", async ({ request }) => {
  const response = await request.get("/login");
  const headers = response.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-powered-by"]).toBeUndefined();
});
