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
export const SITE_BUILD_TIMEOUT_MS = 300_000;

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
  updatedAt: string;
  stableVersion: number | null;
  versions: Record<number, { status: SiteBuildStatus; updatedAt: string }>;
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
    return JSON.parse(raw) as SiteManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    console.warn(`[sites] manifest read failed ${siteId}`, error);
    return null;
  }
}

function sitesIndexPath(dirOverride?: string): string {
  return join(dirOverride ?? siteDataDir(), "sites-index.json");
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
    version = (existing?.version ?? 0) + 1;
    stableVersion = existing?.stableVersion ?? null;
    versions = { ...(existing?.versions ?? {}) };
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
  }
  const { enqueueSiteBuild } = await import("./queue.js");
  await enqueueSiteBuild({
    siteId,
    sessionId: input.sessionId,
    userId: input.userId,
    prompt: input.prompt,
    version,
  });
  return { siteId, version };
}
