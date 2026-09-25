import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSiteScreenshot, extractSiteExcerpt, resolveSiteVersion, viewSitePage } from "./viewing.js";
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
          3: { status: "running", updatedAt: "2026-09-25T00:00:00.000Z" },
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

describe("captureSiteScreenshot", () => {
  const captureArgs = (overrides: Record<string, unknown> = {}) => ({
    ref: { siteId: "s", version: 1 },
    label: "Kedai",
    previewPath: "/api/sites/s/v1/preview/index.html",
    userId: "u",
    sessionId: "sess",
    projectId: null,
    loadManifest: async () => null,
    storeManifest: async () => undefined,
    save: async () => ({ id: "img-1" }),
    ...overrides,
  });

  it("single-flights concurrent captures into one browser run", async () => {
    let runs = 0;
    const fakeBrowser = {
      newPage: async () => ({
        goto: async () => undefined,
        screenshot: async () => {
          runs += 1;
          await new Promise((r) => setTimeout(r, 20));
          return new Uint8Array([137, 80, 78, 71]);
        },
        close: async () => undefined,
      }),
      close: async () => undefined,
    };
    const launch = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return fakeBrowser;
    };
    const [a, b] = await Promise.all([
      captureSiteScreenshot(captureArgs({ launch }) as never),
      captureSiteScreenshot(captureArgs({ launch }) as never),
    ]);
    expect(runs).toBe(1);
    expect(a.imageId).toBe("img-1");
    expect(b.imageId).toBe("img-1");
  });

  it("returns cached screenshots without launching a browser", async () => {
    const launch = vi.fn();
    const out = await captureSiteScreenshot(
      captureArgs({
        ref: { siteId: "s", version: 2 },
        launch,
        loadManifest: async () =>
          ({
            screenshots: {
              2: {
                imageId: "img-9",
                capturedAt: "t",
                viewport: { width: 1440, height: 900 },
                fullPage: true,
                truncated: false,
              },
            },
          }) as never,
      }) as never,
    );
    expect(out.imageId).toBe("img-9");
    expect(launch).not.toHaveBeenCalled();
  });

  it("closes the browser even when the page fails", async () => {    const closes: string[] = [];
    const fakeBrowser = {
      newPage: async () => ({
        goto: async () => {
          throw new Error("nav down");
        },
        screenshot: async () => new Uint8Array(),
        close: async () => {
          closes.push("page");
        },
      }),
      close: async () => {
        closes.push("browser");
      },
    };
    await expect(
      captureSiteScreenshot(captureArgs({ launch: async () => fakeBrowser }) as never),
    ).rejects.toThrow(/nav down/);
    expect(closes.sort()).toEqual(["browser", "page"]);
  });

  it("falls back to viewport capture for pages taller than the cap", async () => {
    const tallPng = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 5, 120, 0, 0, 78, 32, 8, 2, 0, 0, 0,
    ]);
    const calls: Array<{ fullPage?: boolean }> = [];
    const fakeBrowser = {
      newPage: async () => ({
        goto: async () => undefined,
        screenshot: async (opts?: { fullPage?: boolean }) => {
          calls.push({ fullPage: opts?.fullPage });
          return calls.length === 1 ? tallPng : new Uint8Array([137, 80, 78, 71]);
        },
        close: async () => undefined,
      }),
      close: async () => undefined,
    };
    const out = await captureSiteScreenshot(
      captureArgs({ launch: async () => fakeBrowser }) as never,
    );
    expect(calls).toEqual([{ fullPage: true }, { fullPage: false }]);
    expect(out.truncated).toBe(true);
  });
});

describe("viewSitePage", () => {
  it("composes resolve, excerpt, and capture with provenance", async () => {
    const out = await viewSitePage({
      userId: "u",
      sessionId: "sess",
      sessionProjectId: null,
      siteId: "kedai",
      resolve: async () => ({ siteId: "kedai", version: 2 }),
      loadManifest: async () => ({ status: "ready" }) as never,
      excerpt: async () => ({ title: "Kedai", headings: ["Halo"], excerpt: "Halo dunia", truncated: false }),
      capture: async () => ({ imageId: "img-7", capturedAt: "2026-09-25T00:00:00.000Z", truncated: false }),
    });
    expect(out).toMatchObject({
      siteId: "kedai",
      version: 2,
      title: "Kedai",
      excerpt: "Halo dunia",
      imageId: "img-7",
      capturedAt: "2026-09-25T00:00:00.000Z",
      viewport: { width: 1440, height: 900 },
      fullPage: true,
    });
  });

  it("refuses non-ready versions with an explicit message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sites-"));
    try {
      const manifest: SiteManifest = {
        siteId: "warkop",
        sessionId: "sess",
        userId: "u",
        version: 1,
        status: "running",
        previewUrl: null,
        downloadPath: null,
        error: null,
        prompt: "kopi",
        brief: null,
        updatedAt: "2026-09-25T00:00:00.000Z",
        stableVersion: null,
        versions: { 1: { status: "running", updatedAt: "2026-09-25T00:00:00.000Z" } },
      };
      await writeSiteManifest(manifest, dir);
      await writeFile(
        join(dir, "sites-scope-index.json"),
        JSON.stringify({ "u:standalone": [{ siteId: "warkop", siteName: "Warkop", updatedAt: manifest.updatedAt }] }),
        "utf8",
      );
      await expect(
        viewSitePage({ userId: "u", sessionId: "sess", sessionProjectId: null, siteId: "warkop", dir }),
      ).rejects.toThrow(/running — nothing viewable yet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
