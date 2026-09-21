import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  createCompletionModel: vi.fn((modelId: string) => ({ modelId })),
}));

vi.mock("@anreal/agent", () => ({
  createCompletionModel: f.createCompletionModel,
  parseCompletionModel: (value: unknown) =>
    typeof value === "string" && value.trim() ? value : null,
}));

import {
  DEFAULT_SITE_MODEL,
  SITE_BUILD_TIMEOUT_MS,
  readSiteManifest,
  siteBuildConfig,
  siteBuildEnabled,
  writeSiteManifest,
  type SiteManifest,
} from "./service.js";

const MANIFEST: SiteManifest = {
  siteId: "site-1",
  sessionId: "session-1",
  userId: "user-1",
  version: 1,
  status: "queued",
  previewUrl: null,
  downloadPath: null,
  error: null,
  prompt: "bikinkan landing page kopi",
  updatedAt: new Date(0).toISOString(),
};

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SITE_ENABLED", "");
  vi.stubEnv("SITE_MODEL", "");
  vi.stubEnv("SITE_CONCURRENCY", "");
  dir = mkdtempSync(join(tmpdir(), "sites-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("siteBuildConfig", () => {
  it("defaults to enabled Muse Spark builder with concurrency 2", () => {
    expect(siteBuildEnabled()).toBe(true);
    const config = siteBuildConfig();
    expect(config.concurrency).toBe(2);
    expect(config.modelId).toBe(DEFAULT_SITE_MODEL);
    expect(DEFAULT_SITE_MODEL).toBe("meta/muse-spark-1.3-contributor");
    expect(SITE_BUILD_TIMEOUT_MS).toBe(300_000);
    expect(f.createCompletionModel).toHaveBeenCalledWith(DEFAULT_SITE_MODEL);
  });

  it("honors SITE_ENABLED=false and custom model", () => {
    vi.stubEnv("SITE_ENABLED", "false");
    vi.stubEnv("SITE_MODEL", "openai/gpt-5.6-luna");
    expect(siteBuildEnabled()).toBe(false);
    expect(siteBuildConfig().modelId).toBe("openai/gpt-5.6-luna");
  });
});

describe("site manifest store", () => {
  it("round-trips a manifest through site.json", async () => {
    await writeSiteManifest(MANIFEST, dir);
    await expect(readSiteManifest("site-1", dir)).resolves.toEqual(MANIFEST);
  });

  it("returns null for unknown sites", async () => {
    await expect(readSiteManifest("missing", dir)).resolves.toBeNull();
  });

  it("rejects path traversal in site ids", async () => {
    await expect(writeSiteManifest({ ...MANIFEST, siteId: "../evil" }, dir)).rejects.toThrow();
  });
});
