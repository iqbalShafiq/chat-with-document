import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT_ENV = fileURLToPath(new URL("../../.env", import.meta.url));

// The agent package constructs its Mistral client eagerly at import time, so
// any test importing @assingment/agent needs MISTRAL_API_KEY in process.env.
// Inject only that key from the repo .env — loading the whole file would set
// NODE_ENV/PORT/PLATFORM_ORIGIN/... and break env-sensitive tests such as
// src/lib/origins.test.ts (vitest defaults NODE_ENV to "test" when unset).
function loadEnvKeys(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ROOT_ENV)) return out;
  for (const line of readFileSync(ROOT_ENV, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (keys.includes(key)) out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: loadEnvKeys(["MISTRAL_API_KEY"]),
  },
});