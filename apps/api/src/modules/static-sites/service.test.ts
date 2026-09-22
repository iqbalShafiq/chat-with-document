import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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

vi.mock("./queue.js", () => ({
  enqueueSiteBuild: (...args: unknown[]) =>
    (
      (globalThis as { __enqueue?: (...a: unknown[]) => Promise<void> }).__enqueue ??
      (async () => undefined)
    )(...args),
}));

import {
  DEFAULT_SITE_MODEL,
  SITE_BUILD_TIMEOUT_MS,
  enqueueSiteBuildFromTool,
  readActiveSiteTitle,
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
  brief: {
    siteName: "Kopi Senja",
    audience: "pecinta kopi",
    cta: "Pesan",
    sections: ["hero", "kontak"],
    vibe: "hangat",
  },
  updatedAt: new Date(0).toISOString(),
  stableVersion: null,
  versions: { 1: { status: "queued", updatedAt: new Date(0).toISOString() } },
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
  delete (globalThis as { __enqueue?: unknown }).__enqueue;
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

  it("preserves stableVersion and the versions map", async () => {
    const manifest: SiteManifest = {
      ...MANIFEST,
      version: 2,
      status: "ready",
      stableVersion: 1,
      versions: {
        1: { status: "ready", updatedAt: new Date(0).toISOString() },
        2: { status: "ready", updatedAt: new Date(1).toISOString() },
      },
    };
    await writeSiteManifest(manifest, dir);
    await expect(readSiteManifest("site-1", dir)).resolves.toEqual(manifest);
  });

  it("returns null for unknown sites", async () => {
    await expect(readSiteManifest("missing", dir)).resolves.toBeNull();
  });

  it("rejects path traversal in site ids", async () => {
    await expect(writeSiteManifest({ ...MANIFEST, siteId: "../evil" }, dir)).rejects.toThrow();
  });
});

const BRIEF = {
  siteName: "Kopi Senja",
  audience: "pecinta kopi",
  cta: "Pesan",
  sections: ["hero", "kontak"],
  vibe: "hangat",
};

function useTempSiteDir(): string {
  const temp = mkdtempSync(join(tmpdir(), "sites-tool-"));
  vi.stubEnv("SITE_DATA_DIR", temp);
  return temp;
}

describe("readActiveSiteTitle", () => {
  it("round-trips the session index entry", async () => {
    const temp = useTempSiteDir();
    await writeFile(
      join(temp, "sites-index.json"),
      JSON.stringify({ "session-1": { siteId: "site-1", siteName: "Kopi Senja" } }),
      "utf8",
    );
    await expect(readActiveSiteTitle("session-1")).resolves.toEqual({
      siteId: "site-1",
      siteName: "Kopi Senja",
    });
    await expect(readActiveSiteTitle("unknown")).resolves.toBeNull();
  });

  it("returns null for a missing or corrupt index", async () => {
    useTempSiteDir();
    await expect(readActiveSiteTitle("session-1")).resolves.toBeNull();
  });

  it("returns null for a corrupt index file", async () => {
    const temp = useTempSiteDir();
    await writeFile(join(temp, "sites-index.json"), "not json", "utf8");
    await expect(readActiveSiteTitle("session-1")).resolves.toBeNull();
  });
});

describe("enqueueSiteBuildFromTool", () => {
  it("starts fresh sites at version 1 with a queued manifest", async () => {
    const temp = useTempSiteDir();
    const enqueued: unknown[] = [];
    (globalThis as { __enqueue?: unknown }).__enqueue = async (input: unknown) => {
      enqueued.push(input);
    };
    const result = await enqueueSiteBuildFromTool({
      siteId: null,
      sessionId: "session-1",
      userId: "user-1",
      prompt: "bikinkan landing page kopi",
      brief: BRIEF,
    });
    expect(result.siteId).toMatch(/^[0-9a-f-]{8,}$/);
    expect(result.version).toBe(1);
    await expect(readSiteManifest(result.siteId, temp)).resolves.toMatchObject({
      siteId: result.siteId,
      sessionId: "session-1",
      userId: "user-1",
      version: 1,
      status: "queued",
      prompt: "bikinkan landing page kopi",
      brief: BRIEF,
      stableVersion: null,
      versions: { 1: { status: "queued", updatedAt: expect.any(String) } },
    });
    await expect(readActiveSiteTitle("session-1")).resolves.toEqual({
      siteId: result.siteId,
      siteName: "Kopi Senja",
    });
    expect(enqueued).toEqual([
      {
        siteId: result.siteId,
        sessionId: "session-1",
        userId: "user-1",
        prompt: "bikinkan landing page kopi",
        brief: BRIEF,
        version: 1,
      },
    ]);
  });

  it("bumps the version when iterating an existing site", async () => {
    useTempSiteDir();
    const enqueued: unknown[] = [];
    (globalThis as { __enqueue?: unknown }).__enqueue = async (input: unknown) => {
      enqueued.push(input);
    };
    const first = await enqueueSiteBuildFromTool({
      siteId: null,
      sessionId: "session-1",
      userId: "user-1",
      prompt: "bikinkan landing page kopi",
      brief: BRIEF,
    });
    const second = await enqueueSiteBuildFromTool({
      siteId: first.siteId,
      sessionId: "session-1",
      userId: "user-1",
      prompt: "ganti headline",
      brief: BRIEF,
    });
    expect(second).toEqual({ siteId: first.siteId, version: 2 });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]).toMatchObject({ siteId: first.siteId, version: 2 });
    await expect(readSiteManifest(first.siteId)).resolves.toMatchObject({
      version: 2,
      stableVersion: null,
      versions: {
        1: { status: "queued", updatedAt: expect.any(String) },
        2: { status: "queued", updatedAt: expect.any(String) },
      },
    });
  });
});
