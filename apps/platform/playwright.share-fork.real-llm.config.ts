import { defineConfig, devices } from "@playwright/test";

/**
 * Real-LLM share/fork spec (Muse Spark, minimal effort, no stub).
 * Reuses the already-running stack (frontend :3000, API :4312 with real
 * OPENAI_* from `.env`). Boot the app first: `pnpm dev`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/share-fork.real-llm.e2e.ts",
  globalSetup: "./e2e/share-fork.real-llm.global-setup.ts",
  timeout: 600_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    storageState: "./e2e/.auth/real-llm-user.json",
    trace: "retain-on-failure",
    headless: process.env.PW_HEADED !== "1",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
