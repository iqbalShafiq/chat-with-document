import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./queue.js", () => ({
  enqueueSiteBuild: (...args: unknown[]) =>
    ((globalThis as { __enqueue?: (...a: unknown[]) => Promise<void> }).__enqueue ?? (async () => undefined))(...args),
}));

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { siteDownloadRouter } from "./download.js";
import { writeSiteManifest } from "./service.js";

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
    updatedAt: new Date(0).toISOString(),
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
      updatedAt: new Date(0).toISOString(),
    });
    const ready = await siteDownloadRouter.request("/site-2/retry", { method: "POST" });
    expect(ready.status).toBe(409);
    const missing = await siteDownloadRouter.request("/nope/retry", { method: "POST" });
    expect(missing.status).toBe(404);
  });
});
