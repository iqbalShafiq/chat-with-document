import {
  createCompletionModel,
  parseCompletionModel,
  type CompletionModelId,
} from "@anreal/agent";
import type { CompletionModel } from "@anvia/core";
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
  } catch {
    return null;
  }
}
