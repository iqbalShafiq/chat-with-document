import {
  createCompletionModel,
  parseCompletionModel,
  type CompletionModelId,
} from "@anreal/agent";
import type { SiteBrief } from "@anreal/agent";
import type { CompletionModel } from "@anvia/core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_SITE_MODEL: CompletionModelId = "meta/muse-spark-1.3-contributor";
// Budget per agent stream: real high-effort builder runs measured >5min
// (v2 attempt aborted at ~307s on 2026-09-22), so allow 10min.
export const SITE_BUILD_TIMEOUT_MS = 600_000;

export type SiteBuildStatus = "queued" | "running" | "ready" | "failed";

export type SiteManifest = {
  siteId: string;
  sessionId: string;
  userId: string;
  version: number;
  status: SiteBuildStatus;
  previewUrl: string | null;
  downloadPath: string | null;
  error: string | null;
  prompt: string;
  brief: SiteBrief | null;
  updatedAt: string;
  stableVersion: number | null;
  versions: Record<number, { status: SiteBuildStatus; updatedAt: string }>;
  /** Permanent per-version screenshot cache (versions are immutable). */
  screenshots?: Record<
    number,
    {
      imageId: string;
      capturedAt: string;
      viewport: { width: number; height: number };
      fullPage: boolean;
      truncated: boolean;
      mediaType: string;
    }
  >;
};

export type SiteBuildConfig = {
  enabled: boolean;
  concurrency: number;
  modelId: CompletionModelId;
  model: CompletionModel;
  dataDir: string;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;

export function assertSafeSiteId(siteId: string): void {
  if (!SAFE_ID.test(siteId)) throw new Error(`Unsafe site id: ${siteId}`);
}

export function siteDataDir(): string {
  return process.env.SITE_DATA_DIR ?? join(process.cwd(), "data", "sites");
}

export function siteBuildEnabled(): boolean {
  return process.env.SITE_ENABLED !== "false";
}

export function siteBuildConfig(): SiteBuildConfig {
  const concurrency = Number(process.env.SITE_CONCURRENCY ?? "2");
  const modelId = parseCompletionModel(process.env.SITE_MODEL) ?? DEFAULT_SITE_MODEL;
  return {
    enabled: siteBuildEnabled(),
    concurrency:
      Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 2,
    modelId,
    model: createCompletionModel(modelId),
    dataDir: siteDataDir(),
  };
}

function manifestPath(siteId: string, dirOverride?: string): string {
  assertSafeSiteId(siteId);
  return join(dirOverride ?? siteDataDir(), siteId, "site.json");
}

export async function writeSiteManifest(
  manifest: SiteManifest,
  dirOverride?: string,
): Promise<void> {
  const path = manifestPath(manifest.siteId, dirOverride);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}

export async function readSiteManifest(
  siteId: string,
  dirOverride?: string,
): Promise<SiteManifest | null> {
  try {
    const raw = await readFile(manifestPath(siteId, dirOverride), "utf8");
    const parsed = JSON.parse(raw) as SiteManifest;
    return { ...parsed, brief: parsed.brief ?? null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    console.warn(`[sites] manifest read failed ${siteId}`, error);
    return null;
  }
}

function sitesIndexPath(dirOverride?: string): string {
  return join(dirOverride ?? siteDataDir(), "sites-index.json");
}

export async function writeSitesIndex(
  index: Record<string, string | { siteId: string; siteName: string }>,
  dirOverride?: string,
): Promise<void> {
  const path = sitesIndexPath(dirOverride);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(index, null, 2), "utf8");
}

export type SessionSiteEntry = {
  siteId: string;
  sessionId: string;
  version: number;
  stableVersion: number | null;
  status: SiteBuildStatus;
  previewUrl: string | null;
  downloadUrl: string;
  updatedAt: string;
  /** Human label from the brief; null for legacy builds without one. */
  siteName: string | null;
};

/** Resolve a session's project (DB-backed); injected to keep this module disk-only. */
export type SessionProjectResolver = (sessionId: string) => Promise<string | null>;

function sitesScopeIndexPath(dirOverride?: string): string {
  return join(dirOverride ?? siteDataDir(), "sites-scope-index.json");
}

type ScopeIndexEntry = { siteId: string; siteName: string; updatedAt: string };

function scopeKey(userId: string, projectId: string | null): string {
  return `${userId}:${projectId ?? "standalone"}`;
}

async function readScopeIndex(
  dirOverride?: string,
): Promise<Record<string, ScopeIndexEntry[]>> {
  try {
    const raw = await readFile(sitesScopeIndexPath(dirOverride), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, ScopeIndexEntry[]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    console.warn("[sites] scope index read failed", error);
    return {};
  }
}

export async function writeScopeIndex(
  index: Record<string, ScopeIndexEntry[]>,
  dirOverride?: string,
): Promise<void> {
  const path = sitesScopeIndexPath(dirOverride);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(index, null, 2), "utf8");
}

/** Legacy pre-scope index: sessionId → { siteId, siteName }. */
async function readLegacySiteIndex(
  dirOverride?: string,
): Promise<Record<string, { siteId: string; siteName: string | null }>> {
  try {
    const raw = await readFile(sitesIndexPath(dirOverride), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, { siteId: string; siteName: string | null }> = {};
    for (const [sessionId, entry] of Object.entries(parsed)) {
      if (typeof entry === "string" && entry) {
        out[sessionId] = { siteId: entry, siteName: null };
        continue;
      }
      if (typeof entry === "object" && entry !== null) {
        const { siteId, siteName } = entry as { siteId?: unknown; siteName?: unknown };
        if (typeof siteId === "string" && siteId) {
          out[sessionId] = {
            siteId,
            siteName: typeof siteName === "string" && siteName ? siteName : null,
          };
        }
      }
    }
    return out;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    console.warn("[sites] legacy index read failed", error);
    return {};
  }
}

/**
 * Backward-compat (spec §4.4): sites built before the scope index existed
 * live only in `sites-index.json`. Rebuild scope entries from it, resolving
 * each session's project through the injected DB reader.
 */
export async function backfillLegacySiteScope(input: {
  userId: string;
  projectId: string | null;
  dir?: string;
  resolveSessionProject: SessionProjectResolver;
}): Promise<number> {
  const legacy = await readLegacySiteIndex(input.dir);
  const entries = Object.entries(legacy);
  if (entries.length === 0) return 0;
  const index = await readScopeIndex(input.dir);
  const key = scopeKey(input.userId, input.projectId);
  const current = index[key] ?? [];
  const listed = new Set(current.map((entry) => entry.siteId));
  let added = 0;
  for (const [sessionId, entry] of entries) {
    if (listed.has(entry.siteId)) continue;
    let manifest: SiteManifest | null;
    try {
      assertSafeSiteId(entry.siteId);
      manifest = await readSiteManifest(entry.siteId, input.dir);
    } catch {
      continue;
    }
    if (!manifest || manifest.userId !== input.userId) continue;
    const project = await input.resolveSessionProject(sessionId);
    if (project !== input.projectId) continue;
    current.unshift({
      siteId: entry.siteId,
      siteName: entry.siteName ?? manifest.brief?.siteName ?? entry.siteId,
      updatedAt: manifest.updatedAt,
    });
    listed.add(entry.siteId);
    added += 1;
  }
  if (added > 0) {
    index[key] = current.slice(0, 50);
    await writeScopeIndex(index, input.dir);
  }
  return added;
}

export async function listSitesByScope(
  userId: string,
  projectId: string | null,
  opts?: { dir?: string; resolveSessionProject?: SessionProjectResolver },
): Promise<SessionSiteEntry[]> {
  const dirOverride = opts?.dir;
  if (opts?.resolveSessionProject) {
    await backfillLegacySiteScope({
      userId,
      projectId,
      ...(dirOverride ? { dir: dirOverride } : {}),
      resolveSessionProject: opts.resolveSessionProject,
    }).catch((error) => {
      console.warn("[sites] legacy scope backfill failed", error);
    });
  }
  const index = await readScopeIndex(dirOverride);
  const entries = index[scopeKey(userId, projectId)] ?? [];
  const out: SessionSiteEntry[] = [];
  for (const entry of entries) {
    try {
      assertSafeSiteId(entry.siteId);
    } catch {
      continue;
    }
    const manifest = await readSiteManifest(entry.siteId, dirOverride);
    if (!manifest || manifest.userId !== userId) continue;
    out.push({
      siteId: manifest.siteId,
      sessionId: manifest.sessionId,
      version: manifest.version,
      stableVersion: manifest.stableVersion,
      status: manifest.status,
      previewUrl: manifest.previewUrl,
      downloadUrl: `/api/sites/${manifest.siteId}/v${manifest.version}/download`,
      updatedAt: manifest.updatedAt,
      siteName: entry.siteName ?? manifest.brief?.siteName ?? null,
    });
  }
  return out;
}

/**
 * Single scoped manifest read: membership in the caller's scope index plus
 * userId match. Legacy sites (pre-scope-index) are backfilled on demand when
 * a resolver is provided. Anything else is null (callers map to generic 404).
 */
export async function getScopedSite(
  userId: string,
  projectId: string | null,
  siteId: string,
  dirOverride?: string,
  resolveSessionProject?: SessionProjectResolver,
): Promise<SiteManifest | null> {
  try {
    assertSafeSiteId(siteId);
  } catch {
    return null;
  }
  let index = await readScopeIndex(dirOverride);
  const listed = (index[scopeKey(userId, projectId)] ?? []).some((e) => e.siteId === siteId);
  if (!listed && resolveSessionProject) {
    await backfillLegacySiteScope({
      userId,
      projectId,
      ...(dirOverride ? { dir: dirOverride } : {}),
      resolveSessionProject,
    }).catch(() => undefined);
    index = await readScopeIndex(dirOverride);
  }
  const listedAfter = (index[scopeKey(userId, projectId)] ?? []).some(
    (e) => e.siteId === siteId,
  );
  if (!listedAfter) return null;
  const manifest = await readSiteManifest(siteId, dirOverride);
  if (!manifest || manifest.userId !== userId) return null;
  return manifest;
}

export async function listSitesBySession(
  sessionId: string,
  dirOverride?: string,
): Promise<SessionSiteEntry[]> {
  try {
    const raw = await readFile(sitesIndexPath(dirOverride), "utf8");
    const index = JSON.parse(raw) as Record<string, unknown>;
    const entry = index[sessionId];
    let siteId: string | null = null;
    if (typeof entry === "string") {
      siteId = entry;
    } else if (typeof entry === "object" && entry !== null) {
      const candidate = (entry as { siteId?: unknown }).siteId;
      if (typeof candidate === "string" && candidate) siteId = candidate;
    }
    if (!siteId) return [];
    const manifest = await readSiteManifest(siteId, dirOverride);
    if (!manifest) return [];
    return [
      {
        siteId: manifest.siteId,
        sessionId: manifest.sessionId,
        version: manifest.version,
        stableVersion: manifest.stableVersion,
        status: manifest.status,
        previewUrl: manifest.previewUrl,
        downloadUrl: `/api/sites/${manifest.siteId}/v${manifest.version}/download`,
        updatedAt: manifest.updatedAt,
        siteName: manifest.brief?.siteName ?? null,
      },
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    console.warn("[sites] session sites read failed", error);
    return [];
  }
}

export async function readActiveSiteTitle(
  sessionId: string,
  dirOverride?: string,
): Promise<{ siteId: string; siteName: string } | null> {
  if (!sessionId) return null;
  try {
    const raw = await readFile(sitesIndexPath(dirOverride), "utf8");
    const entry = (JSON.parse(raw) as Record<string, unknown>)[sessionId];
    if (typeof entry !== "object" || entry === null) return null;
    const { siteId, siteName } = entry as { siteId?: unknown; siteName?: unknown };
    if (typeof siteId !== "string" || !siteId) return null;
    if (typeof siteName !== "string" || !siteName) return null;
    return { siteId, siteName };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    console.warn("[sites] index read failed", error);
    return null;
  }
}

export async function enqueueSiteBuildFromTool(
  input: {
    siteId: string | null;
    sessionId: string;
    userId: string;
    projectId?: string | null;
    prompt: string;
    brief: SiteBrief;
  },
  dirOverride?: string,
): Promise<{ siteId: string; version: number }> {
  let siteId = input.siteId;
  let version: number;
  let stableVersion: number | null = null;
  let versions: SiteManifest["versions"] = {};
  if (!siteId) {
    siteId = randomUUID();
    version = 1;
  } else {
    const existing = await readSiteManifest(siteId, dirOverride);
    // Rebuilds may only touch the caller's own site (UUID ids are
    // unguessable, but scope must never rely on that).
    if (!existing || existing.userId !== input.userId) {
      throw new Error("Site not found in the current scope.");
    }
    version = (existing.version ?? 0) + 1;
    stableVersion = existing.stableVersion ?? null;
    versions = { ...(existing.versions ?? {}) };
  }
  const updatedAt = new Date().toISOString();
  versions[version] = { status: "queued", updatedAt };
  await writeSiteManifest(
    {
      siteId,
      sessionId: input.sessionId,
      userId: input.userId,
      version,
      status: "queued",
      previewUrl: null,
      downloadPath: null,
      error: null,
      prompt: input.prompt,
      brief: input.brief,
      updatedAt,
      stableVersion,
      versions,
    },
    dirOverride,
  );
  if (input.sessionId) {
    try {
      const path = sitesIndexPath(dirOverride);
      let index: Record<string, { siteId: string; siteName: string }> = {};
      try {
        index = JSON.parse(await readFile(path, "utf8")) as typeof index;
        if (typeof index !== "object" || index === null || Array.isArray(index)) index = {};
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.warn("[sites] index read failed", error);
        }
      }
      index[input.sessionId] = { siteId, siteName: input.brief.siteName };
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify(index, null, 2), "utf8");
    } catch (error) {
      console.warn("[sites] index write failed", error);
    }
    try {
      const scopeIndex = await readScopeIndex(dirOverride);
      const key = scopeKey(input.userId, input.projectId ?? null);
      // A rebuild from another scope MOVES the site: drop any stale entry
      // under this user's other scope keys, then insert into the current one.
      const userPrefix = `${input.userId}:`;
      for (const existingKey of Object.keys(scopeIndex)) {
        if (existingKey !== key && existingKey.startsWith(userPrefix)) {
          const filtered = (scopeIndex[existingKey] ?? []).filter((e) => e.siteId !== siteId);
          if (filtered.length !== (scopeIndex[existingKey] ?? []).length) {
            scopeIndex[existingKey] = filtered;
          }
        }
      }
      const existing = scopeIndex[key] ?? [];
      const without = existing.filter((e) => e.siteId !== siteId);
      without.unshift({ siteId, siteName: input.brief.siteName, updatedAt });
      scopeIndex[key] = without.slice(0, 50);
      await writeScopeIndex(scopeIndex, dirOverride);
    } catch (error) {
      console.warn("[sites] scope index write failed", error);
    }
  }
  const { enqueueSiteBuild } = await import("./queue.js");
  await enqueueSiteBuild({
    siteId,
    sessionId: input.sessionId,
    userId: input.userId,
    prompt: input.prompt,
    brief: input.brief,
    version,
  });
  return { siteId, version };
}
