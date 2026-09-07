import { defineConfig, devices } from "@playwright/test";

/**
 * Headed Chromium against the real OpenRouter stack (`pnpm dev` + `.env`).
 * Does not start the local stub. Boot the app first:
 *   PORT=3001 BETTER_AUTH_URL=http://localhost:3001 pnpm dev
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["*real-llm*.e2e.ts", "anvia-v1-migration.e2e.ts"],
  globalSetup: "./e2e/real-llm.global-setup.ts",
  timeout: 300_000,
  expect: { timeout: 180_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    storageState: "./e2e/.auth/real-llm-user.json",
    trace: "retain-on-failure",
    // Official default is headless. Pass `--headed` locally to watch the browser.
    headless: process.env.PW_HEADED !== "1",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
