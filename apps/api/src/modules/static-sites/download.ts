import { Hono } from "hono";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { requireUser } from "../auth/middleware.js";
import { enqueueSiteBuild } from "./queue.js";
import {
  assertSafeSiteId,
  listSitesBySession,
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
    brief: manifest.brief ?? null,
    version: manifest.version,
  }).catch(() => undefined);
  return c.json({ siteId, version: manifest.version, status: "queued" }, 202);
});

siteDownloadRouter.get("/by-session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(sessionId ?? "")) {
    return c.json({ error: "invalid session id" }, 400);
  }
  const sites = await listSitesBySession(sessionId);
  return c.json({ sites });
});

const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// NOTE: Hono 4.12 does not expose the `*` wildcard via c.req.param()
// (verified: param() returns only named params), so the subpath is derived
// from c.req.path instead. c.req.path stays percent-encoded (verified), so it
// is decoded before the traversal check. URL shape is unchanged:
// GET /api/sites/:siteId/v:version/preview/*.
siteDownloadRouter.get("/:siteId/:version/preview/*", async (c) => {
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
  // c.req.path carries the full path including the router mount prefix
  // (app.ts mounts this router at /api/sites), so the preview segment is
  // located by its validated neighbors instead of anchoring at the string
  // start. Comparison is exact: siteId (SAFE_ID) and the vN segment need no
  // encoding, so encoded and decoded forms coincide here.
  const segments = c.req.path.split("/");
  const marker = segments.findIndex(
    (_, i) => segments[i] === "preview" && segments[i - 2] === siteId && segments[i - 1] === rawVersion,
  );
  const encoded = (marker === -1 ? "" : segments.slice(marker + 1).join("/")).replace(
    /^\/+/,
    "",
  );
  let rest: string;
  try {
    rest = decodeURIComponent(encoded);
  } catch {
    return c.json({ error: "invalid path" }, 400);
  }
  if (rest.split("/").some((segment) => segment === ".." || segment.includes("\\"))) {
    return c.json({ error: "invalid path" }, 400);
  }
  const base = join(siteDataDir(), siteId, `v${version}`);
  const candidates = rest ? [join(base, rest), join(base, "index.html")] : [join(base, "index.html")];
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(candidate);
      const extension = extname(candidate).toLowerCase();
      return new Response(bytes, {
        headers: {
          "content-type": PREVIEW_CONTENT_TYPES[extension] ?? "application/octet-stream",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    } catch {
      // try next candidate, then 404 below
    }
  }
  return c.json({ error: "preview not found" }, 404);
});

const rollbackBody = z.object({ version: z.number().int().min(1).max(10_000) });

siteDownloadRouter.post("/:siteId/rollback", async (c) => {
  const siteId = c.req.param("siteId");
  try {
    assertSafeSiteId(siteId);
  } catch {
    return c.json({ error: "invalid site id" }, 400);
  }
  const parsed = rollbackBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid version" }, 400);
  const manifest = await readSiteManifest(siteId);
  if (!manifest) return c.json({ error: "build not found" }, 404);
  if (manifest.versions?.[parsed.data.version]?.status !== "ready") {
    return c.json({ error: "version is not ready" }, 409);
  }
  const updated = { ...manifest, stableVersion: parsed.data.version, updatedAt: new Date().toISOString() };
  await writeSiteManifest(updated);
  return c.json(updated);
});
