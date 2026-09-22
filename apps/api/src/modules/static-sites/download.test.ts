import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("./queue.js", () => ({
  enqueueSiteBuild: (...args: unknown[]) =>
    ((globalThis as { __enqueue?: (...a: unknown[]) => Promise<void> }).__enqueue ?? (async () => undefined))(...args),
}));

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { siteDownloadRouter } from "./download.js";
import { writeSiteManifest, writeSitesIndex } from "./service.js";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __enqueue?: unknown }).__enqueue;
});

function useTempSiteDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "site-dl-"));
  vi.stubEnv("SITE_DATA_DIR", dir);
  return dir;
}

function seedZip(): string {
  const dir = useTempSiteDir();
  mkdirSync(join(dir, "site-1", "v1"), { recursive: true });
  writeFileSync(join(dir, "site-1", "v1", "site.zip"), Buffer.from("PK-fake-zip"));
  return dir;
}

async function seedFailedManifest(): Promise<void> {
  seedZip();
  await writeSiteManifest({
    siteId: "site-1",
    sessionId: "session-1",
    userId: "user-1",
    version: 1,
    status: "failed",
    previewUrl: null,
    downloadPath: null,
    error: "vite build failed: boom",
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
    versions: { 1: { status: "failed", updatedAt: new Date(0).toISOString() } },
  });
}

describe("site download", () => {
  it("serves the zip with attachment headers", async () => {
    seedZip();
    const response = await siteDownloadRouter.request("/site-1/v1/download");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/zip");
    expect(response.headers.get("content-disposition")).toContain("site-1-v1.zip");
    expect(await response.arrayBuffer()).toBeTruthy();
  });

  it("returns 404 for unknown builds and rejects traversal", async () => {
    seedZip();
    const missing = await siteDownloadRouter.request("/nope/v9/download");
    expect(missing.status).toBe(404);
    // Encoded slash may fail route matching (404) or hit the guard (400):
    // both mean the traversal is rejected.
    const traversal = await siteDownloadRouter.request("/..%2Fevil/v1/download");
    expect([400, 404]).toContain(traversal.status);
  });

  it("retries a failed build at the same version", async () => {
    await seedFailedManifest();
    const enqueued: unknown[] = [];
    (globalThis as { __enqueue?: unknown }).__enqueue = async (input: unknown) => {
      enqueued.push(input);
    };
    const response = await siteDownloadRouter.request("/site-1/retry", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ siteId: "site-1", version: 1, status: "queued" });
    expect(enqueued).toEqual([
      {
        siteId: "site-1",
        sessionId: "session-1",
        userId: "user-1",
        prompt: "bikinkan landing page kopi",
        brief: {
          siteName: "Kopi Senja",
          audience: "pecinta kopi",
          cta: "Pesan",
          sections: ["hero", "kontak"],
          vibe: "hangat",
        },
        version: 1,
      },
    ]);
  });

  it("refuses retry for ready builds and unknown sites", async () => {
    await seedFailedManifest();
    await writeSiteManifest({
      siteId: "site-2",
      sessionId: "session-1",
      userId: "user-1",
      version: 1,
      status: "ready",
      previewUrl: "http://127.0.0.1:49111",
      downloadPath: "/tmp/x/site.zip",
      error: null,
      prompt: "x",
      brief: null,
      updatedAt: new Date(0).toISOString(),
      stableVersion: 1,
      versions: { 1: { status: "ready", updatedAt: new Date(0).toISOString() } },
    });
    const ready = await siteDownloadRouter.request("/site-2/retry", { method: "POST" });
    expect(ready.status).toBe(409);
    const missing = await siteDownloadRouter.request("/nope/retry", { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

describe("site static preview", () => {
  it("serves dist files with content types and index fallback", async () => {
    const dir = useTempSiteDir();
    mkdirSync(join(dir, "site-1", "v1", "assets"), { recursive: true });
    writeFileSync(join(dir, "site-1", "v1", "index.html"), "<html>hi</html>");
    writeFileSync(join(dir, "site-1", "v1", "assets", "app.css"), "body{}");
    await writeSiteManifest({
      siteId: "site-1", sessionId: "session-1", userId: "user-1", version: 1,
      status: "ready", previewUrl: null, downloadPath: "x", error: null,
      prompt: "x", brief: null, stableVersion: 1, updatedAt: new Date(0).toISOString(),
      versions: { 1: { status: "ready", updatedAt: new Date(0).toISOString() } },
    });

    const html = await siteDownloadRouter.request("/site-1/v1/preview/index.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("access-control-allow-origin")).toBe("*");
    expect(await html.text()).toContain("hi");

    const css = await siteDownloadRouter.request("/site-1/v1/preview/assets/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("access-control-allow-origin")).toBe("*");

    const fallback = await siteDownloadRouter.request("/site-1/v1/preview/some/route");
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("hi");
  });

  it("rejects traversal and unknown builds", async () => {
    useTempSiteDir();
    const traversal = await siteDownloadRouter.request("/..%2Fevil/v1/preview/index.html");
    expect([400, 404]).toContain(traversal.status);
    const missing = await siteDownloadRouter.request("/nope/v9/preview/index.html");
    expect(missing.status).toBe(404);
  });

  it("serves nested assets when mounted under /api/sites", async () => {
    const dir = useTempSiteDir();
    mkdirSync(join(dir, "site-1", "v1", "assets"), { recursive: true });
    writeFileSync(join(dir, "site-1", "v1", "index.html"), "<html>hi</html>");
    writeFileSync(join(dir, "site-1", "v1", "assets", "app.css"), "body{}");
    await writeSiteManifest({
      siteId: "site-1", sessionId: "session-1", userId: "user-1", version: 1,
      status: "ready", previewUrl: null, downloadPath: "x", error: null,
      prompt: "x", brief: null, stableVersion: 1, updatedAt: new Date(0).toISOString(),
      versions: { 1: { status: "ready", updatedAt: new Date(0).toISOString() } },
    });
    const app = new Hono().route("/api/sites", siteDownloadRouter);
    const css = await app.request("/api/sites/site-1/v1/preview/assets/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("body{}");
  });
});

describe("site by-session and rollback", () => {
  it("lists session sites and moves the stable pointer", async () => {
    const dir = useTempSiteDir();
    mkdirSync(join(dir, "site-1", "v1"), { recursive: true });
    mkdirSync(join(dir, "site-1", "v2"), { recursive: true });
    writeFileSync(join(dir, "site-1", "v1", "site.zip"), Buffer.from("PK-1"));
    writeFileSync(join(dir, "site-1", "v2", "site.zip"), Buffer.from("PK-2"));
    await writeSiteManifest({
      siteId: "site-1", sessionId: "session-1", userId: "user-1", version: 2,
      status: "ready", previewUrl: null, downloadPath: "x", error: null,
      prompt: "x", brief: null, stableVersion: 2, updatedAt: new Date(0).toISOString(),
      versions: {
        1: { status: "ready", updatedAt: new Date(0).toISOString() },
        2: { status: "ready", updatedAt: new Date(0).toISOString() },
      },
    });
    await writeSitesIndex({ "session-1": "site-1" }, dir);

    const list = await siteDownloadRouter.request("/by-session/session-1");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      sites: [{ siteId: "site-1", version: 2, stableVersion: 2, status: "ready" }],
    });

    const rollback = await siteDownloadRouter.request("/site-1/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ stableVersion: 1 });

    const badVersion = await siteDownloadRouter.request("/site-1/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 9 }),
    });
    expect(badVersion.status).toBe(409);
  });

  it("skips index entries without a manifest", async () => {
    const dir = useTempSiteDir();
    await writeSitesIndex({ "session-1": "site-gone" }, dir);
    const list = await siteDownloadRouter.request("/by-session/session-1");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ sites: [] });
  });
});
