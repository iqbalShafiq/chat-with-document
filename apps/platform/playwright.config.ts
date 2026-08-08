import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: "http://localhost:3000",
    storageState: "./e2e/.auth/user.json",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "node e2e/stub-openrouter.ts & OPENAI_BASE_URL=http://127.0.0.1:18765/api/v1 OPENAI_API_KEY=e2e-key TAVILY_API_KEY=dummy pnpm --dir ../.. dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
