import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractSiteExcerpt, resolveSiteVersion } from "./viewing.js";
import { writeSiteManifest, type SiteManifest } from "./service.js";

describe("extractSiteExcerpt", () => {
  it("strips scripts and tags with a char bound", async () => {
    const html = `<html><head><title>Kedai</title><script>alert(1)</script></head><body><h1>Halo</h1><p>Dunia</p></body></html>`;
    const out = await extractSiteExcerpt({
      ref: { siteId: "s", version: 1 },
      readHtml: async () => html,
      maxChars: 10,
    });
    expect(out.title).toBe("Kedai");
    expect(out.excerpt).not.toContain("alert");
    expect(out.excerpt.length).toBeLessThanOrEqual(10);
    expect(out.truncated).toBe(true);
  });
});

describe("resolveSiteVersion", () => {
  it("rejects path traversal before touching disk", async () => {
    await expect(
      resolveSiteVersion({ userId: "u", sessionProjectId: null, siteId: "../../etc", version: 1 }),
    ).rejects.toThrow(/not found/i);
  });

  it("resolves the stable version by default and explicit versions verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sites-"));
    try {
      const manifest: SiteManifest = {
        siteId: "kedai",
        sessionId: "sess",
        userId: "u",
        version: 3,
        status: "ready",
        previewUrl: "/api/sites/kedai/v3/preview/index.html",
        downloadPath: null,
        error: null,
        prompt: "kopi",
        brief: null,
        updatedAt: "2026-09-25T00:00:00.000Z",
        stableVersion: 2,
        versions: {
          2: { status: "ready", updatedAt: "2026-09-25T00:00:00.000Z" },
          3: { status: "building", updatedAt: "2026-09-25T00:00:00.000Z" },
        },
      };
      await writeSiteManifest(manifest, dir);
      await writeFile(
        join(dir, "sites-scope-index.json"),
        JSON.stringify({ "u:standalone": [{ siteId: "kedai", siteName: "Kedai", updatedAt: manifest.updatedAt }] }),
        "utf8",
      );
      await expect(
        resolveSiteVersion({ userId: "u", sessionProjectId: null, siteId: "kedai", dir }),
      ).resolves.toEqual({ siteId: "kedai", version: 2 });
      await expect(
        resolveSiteVersion({ userId: "u", sessionProjectId: null, siteId: "kedai", version: 3, dir }),
      ).resolves.toEqual({ siteId: "kedai", version: 3 });
      await expect(
        resolveSiteVersion({ userId: "other", sessionProjectId: null, siteId: "kedai", dir }),
      ).rejects.toThrow(/not found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps huge files before stripping", async () => {
    const big = `<p>${"x".repeat(300_000)}</p>`;
    const out = await extractSiteExcerpt({
      ref: { siteId: "s", version: 1 },
      readHtml: async () => big,
      maxChars: 6000,
    });
    expect(out.excerpt.length).toBeLessThanOrEqual(6000);
    expect(out.truncated).toBe(true);
  });
});
