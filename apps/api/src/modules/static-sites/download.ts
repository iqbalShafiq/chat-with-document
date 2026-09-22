import { Hono } from "hono";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { requireUser } from "../auth/middleware.js";
import { enqueueSiteBuild } from "./queue.js";
import {
  assertSafeSiteId,
  readSiteManifest,
  siteDataDir,
  writeSiteManifest,
} from "./service.js";

export const siteDownloadRouter = new Hono();

siteDownloadRouter.use("*", requireUser);

// NOTE: Hono 4.12 does not capture partial-segment params like `v:version`
// (c.req.param("version") comes back undefined), so the version segment is
// captured whole ("v1") and the `v` prefix is stripped here. URL shape is
// unchanged: GET /api/sites/:siteId/v:version/download.
siteDownloadRouter.get("/:siteId/:version/download", async (c) => {
  const siteId = c.req.param("siteId");
  const rawVersion = String(c.req.param("version") ?? "");
  const version = rawVersion.startsWith("v") ? Number(rawVersion.slice(1)) : NaN;
  try {
    assertSafeSiteId(siteId);
  } catch {
    return c.json({ error: "invalid site id" }, 400);
  }
  if (!Number.isInteger(version) || version < 1 || version > 10_000) {
    return c.json({ error: "invalid version" }, 400);
  }
  const path = join(siteDataDir(), siteId, `v${version}`, "site.zip");
  try {
    await stat(path);
  } catch {
    return c.json({ error: "build not found" }, 404);
  }
  const bytes = await readFile(path);
  return new Response(bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="site-${siteId}-v${version}.zip"`,
      "content-length": String(bytes.length),
    },
  });
});

siteDownloadRouter.post("/:siteId/retry", async (c) => {
  const siteId = c.req.param("siteId");
  try {
    assertSafeSiteId(siteId);
  } catch {
    return c.json({ error: "invalid site id" }, 400);
  }
  const manifest = await readSiteManifest(siteId);
  if (!manifest) return c.json({ error: "build not found" }, 404);
  if (manifest.status !== "failed") {
    return c.json({ error: "only failed builds can be retried" }, 409);
  }
  await writeSiteManifest({
    ...manifest,
    status: "queued",
    error: null,
    updatedAt: new Date().toISOString(),
  });
  await enqueueSiteBuild({
    siteId: manifest.siteId,
    sessionId: manifest.sessionId,
    userId: manifest.userId,
    prompt: manifest.prompt,
    version: manifest.version,
  }).catch(() => undefined);
  return c.json({ siteId, version: manifest.version, status: "queued" }, 202);
});
