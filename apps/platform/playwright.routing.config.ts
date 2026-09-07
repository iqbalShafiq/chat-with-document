import { defineConfig, devices } from "@playwright/test";

/**
 * Routing-spec config: reuses an already-running stack (frontend :3000,
 * API :4312, stub :18765) instead of booting `webServer`. Start the stack
 * first: `node apps/platform/e2e/stub-openrouter.ts` + `pnpm dev` with the
 * stub env. Not for CI — the default config owns server lifecycle there.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/workspace-routing.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    storageState: "./e2e/.auth/user.json",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
