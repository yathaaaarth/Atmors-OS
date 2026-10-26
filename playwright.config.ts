import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// Authenticated journeys need the dev Supabase credentials (skipped without them).
config({ path: ".env.local", quiet: true });

const port = Number(process.env.PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  // Journeys make many round trips to the hosted dev database.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Stateful journeys run once (desktop); mobile covers rendering and accessibility.
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: /-journey/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npm run start -- --port ${port}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
