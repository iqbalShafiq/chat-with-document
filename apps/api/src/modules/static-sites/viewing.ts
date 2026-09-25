import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import {
  assertSafeSiteId,
  getScopedSite,
  readSiteManifest,
  siteDataDir,
  writeSiteManifest,
  type SiteManifest,
} from "./service.js";
import { getImageStore } from "../images/service.js";

export type SiteVersionRef = { siteId: string; version: number };

export async function resolveSiteVersion(input: {
  userId: string;
  sessionProjectId: string | null;
  siteId: string;
  version?: number;
  /** Test/override seam for the sites data dir. */
  dir?: string;
}): Promise<SiteVersionRef> {
  const manifest = await getScopedSite(input.userId, input.sessionProjectId, input.siteId, input.dir);
  if (!manifest) throw new Error("Site not found in the current scope.");
  const version = input.version ?? manifest.stableVersion ?? manifest.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Site version not found in the current scope.");
  }
  return { siteId: manifest.siteId, version };
}

const READ_CAP_BYTES = 256 * 1024;

export async function readSiteIndexHtml(ref: SiteVersionRef): Promise<string> {
  assertSafeSiteId(ref.siteId);
  const path = join(siteDataDir(), ref.siteId, `v${ref.version}`, "index.html");
  const handle = await readFile(path, "utf8").catch(() => null);
  // Pola baca-dibatasi: baca penuh lalu potong — file dist statis kecil;
  // cap di sini mencegah OOM bila ada aset raksasa nyasar.
  if (handle === null) throw new Error("Site page has nothing viewable yet.");
  return handle.length > READ_CAP_BYTES ? handle.slice(0, READ_CAP_BYTES) : handle;
}

export function stripHtmlToText(html: string, maxChars: number): {
  title: string;
  headings: string[];
  excerpt: string;
  truncated: boolean;
} {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title,
    headings,
    excerpt: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
  };
}

export async function extractSiteExcerpt(input: {
  ref: SiteVersionRef;
  maxChars?: number;
  readHtml?: (ref: SiteVersionRef) => Promise<string>;
}): Promise<{ title: string; headings: string[]; excerpt: string; truncated: boolean }> {
  const html = await (input.readHtml ?? readSiteIndexHtml)(input.ref);
  return stripHtmlToText(html, input.maxChars ?? 6000);
}

export const SITE_SCREENSHOT_VIEWPORT = { width: 1440, height: 900 };
const SITE_SCREENSHOT_MAX_HEIGHT_PX = 16_000;
const SITE_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const SITE_SCREENSHOT_NAV_TIMEOUT_MS = 15_000;
const SITE_SCREENSHOT_TOTAL_TIMEOUT_MS = 30_000;
const SITE_SCREENSHOT_MAX_CONCURRENT = 2;
const API_INTERNAL_ORIGIN = process.env.API_INTERNAL_ORIGIN ?? "http://localhost:4312";

/** Minimal browser surface — real Playwright in prod, fakes in tests. */
export type ViewingPage = {
  goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  screenshot: (opts?: {
    fullPage?: boolean;
    timeout?: number;
    type?: "png" | "jpeg";
    quality?: number;
  }) => Promise<Uint8Array>;
  close: () => Promise<unknown>;
};
export type ViewingBrowser = {
  newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<ViewingPage>;
  close: () => Promise<unknown>;
};

async function launchChromium(): Promise<ViewingBrowser> {
  try {
    return (await chromium.launch({ channel: "chrome" })) as unknown as ViewingBrowser;
  } catch {
    return (await chromium.launch()) as unknown as ViewingBrowser;
  }
}

// FIFO semaphore so captures never exceed the browser budget.
let activeCaptures = 0;
const captureQueue: Array<() => void> = [];

async function acquireCaptureSlot(): Promise<void> {
  if (activeCaptures < SITE_SCREENSHOT_MAX_CONCURRENT) {
    activeCaptures += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    captureQueue.push(resolve);
  });
  activeCaptures += 1;
}

function releaseCaptureSlot(): void {
  activeCaptures = Math.max(0, activeCaptures - 1);
  captureQueue.shift()?.();
}

// Single-flight per (siteId, version): concurrent callers share one capture.
export type ScreenshotShot = {
  imageId: string;
  capturedAt: string;
  truncated: boolean;
  mediaType: string;
};

const inflightCaptures = new Map<string, Promise<ScreenshotShot>>();

export type CaptureDeps = {
  launch?: () => Promise<ViewingBrowser>;
  save?: (args: {
    buffer: Uint8Array;
    width: number;
    height: number;
    mediaType: string;
  }) => Promise<{ id: string }>;
  loadManifest?: (siteId: string) => Promise<SiteManifest | null>;
  storeManifest?: (manifest: SiteManifest) => Promise<void>;
  /** Test seam for the total capture budget (default 30s). */
  totalTimeoutMs?: number;
};

export async function captureSiteScreenshot(input: {
  ref: SiteVersionRef;
  label: string;
  previewPath: string;
  userId: string;
  sessionId: string;
  projectId: string | null;
} & CaptureDeps): Promise<ScreenshotShot> {
  const key = `${input.ref.siteId}:v${input.ref.version}`;
  const cached = (await (input.loadManifest ?? readSiteManifest)(input.ref.siteId))?.screenshots?.[
    input.ref.version
  ];
  if (cached) {
    return {
      imageId: cached.imageId,
      capturedAt: cached.capturedAt,
      truncated: cached.truncated,
      mediaType: cached.mediaType ?? "image/png",
    };
  }
  const pending = inflightCaptures.get(key);
  if (pending) return pending;
  const run = (async () => {
    await acquireCaptureSlot();
    try {
      return await runCapture(input);
    } finally {
      releaseCaptureSlot();
    }
  })();
  inflightCaptures.set(key, run);
  try {
    return await run;
  } finally {
    inflightCaptures.delete(key);
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Site screenshot timed out.")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** PNG IHDR height without any image dependency (width at 16, height at 20). */
export function pngHeightPx(buffer: Uint8Array): number {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return (buffer[20]! << 24) | (buffer[21]! << 16) | (buffer[22]! << 8) | buffer[23]!;
  }
  return 0;
}

async function runCapture(
  input: Parameters<typeof captureSiteScreenshot>[0],
): Promise<ScreenshotShot> {
  const browser = await (input.launch ?? launchChromium)();
  try {
    const page = await browser.newPage({ viewport: SITE_SCREENSHOT_VIEWPORT });
    try {
      // The total budget lives INSIDE this try/finally so a timeout still
      // closes page + browser before the run settles (no orphan browsers,
      // no semaphore leak).
      const work = (async (): Promise<ScreenshotShot> => {
        await page.goto(`${API_INTERNAL_ORIGIN}${input.previewPath}`, {
          waitUntil: "networkidle",
          timeout: SITE_SCREENSHOT_NAV_TIMEOUT_MS,
        });
        // Fallback chain enforcing the byte cap without new dependencies:
        // fullPage PNG → viewport PNG → viewport JPEG. Each fallback marks
        // the shot truncated so the agent knows what it is seeing.
        let buffer = Buffer.from(
          await page.screenshot({ fullPage: true, timeout: SITE_SCREENSHOT_NAV_TIMEOUT_MS }),
        );
        let mediaType = "image/png";
        let fullPage = true;
        let truncated = buffer.length > SITE_SCREENSHOT_MAX_BYTES;
        if (!truncated && pngHeightPx(buffer) > SITE_SCREENSHOT_MAX_HEIGHT_PX) {
          buffer = Buffer.from(
            await page.screenshot({ fullPage: false, timeout: SITE_SCREENSHOT_NAV_TIMEOUT_MS }),
          );
          fullPage = false;
          truncated = true;
        }
        if (buffer.length > SITE_SCREENSHOT_MAX_BYTES) {
          buffer = Buffer.from(
            await page.screenshot({
              fullPage: false,
              type: "jpeg",
              quality: 70,
              timeout: SITE_SCREENSHOT_NAV_TIMEOUT_MS,
            }),
          );
          mediaType = "image/jpeg";
          fullPage = false;
          truncated = true;
        }
      const saved = input.save
        ? await input.save({
            buffer,
            width: SITE_SCREENSHOT_VIEWPORT.width,
            height: SITE_SCREENSHOT_VIEWPORT.height,
            mediaType,
          })
        : await getImageStore().saveGeneratedImage({
            userId: input.userId,
            sessionId: input.sessionId,
            projectId: input.projectId,
            buffer,
            mediaType,
            modelId: "site-screenshot",
            prompt: input.label,
            caption: `Screenshot site ${input.label} v${input.ref.version}`,
            width: SITE_SCREENSHOT_VIEWPORT.width,
            height: SITE_SCREENSHOT_VIEWPORT.height,
            source: "site-screenshot",
          });
      const capturedAt = new Date().toISOString();
      const manifest = await (input.loadManifest ?? readSiteManifest)(input.ref.siteId);
      if (manifest) {
        await (input.storeManifest ?? writeSiteManifest)({
          ...manifest,
          screenshots: {
            ...(manifest.screenshots ?? {}),
            [input.ref.version]: {
              imageId: saved.id,
              capturedAt,
              viewport: SITE_SCREENSHOT_VIEWPORT,
              fullPage,
              truncated,
              mediaType,
            },
          },
        });
      }
      return { imageId: saved.id, capturedAt, truncated, mediaType };
      })();
      return await withTimeout(work, input.totalTimeoutMs ?? SITE_SCREENSHOT_TOTAL_TIMEOUT_MS);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export type ViewSitePageResult = {
  siteId: string;
  version: number;
  status: string;
  title: string;
  headings: string[];
  excerpt: string;
  excerptTruncated: boolean;
  imageId: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  fullPage: boolean;
  truncated: boolean;
  mediaType: string;
  /** Set when the screenshot failed but the excerpt survived. The agent can still answer partially and may retry. */
  captureError: string | null;
  retryable: boolean;
};

export async function viewSitePage(input: {
  userId: string;
  sessionId: string;
  sessionProjectId: string | null;
  siteId: string;
  version?: number;
  question?: string;
  dir?: string;
  resolve?: typeof resolveSiteVersion;
  loadManifest?: (siteId: string, dir?: string) => Promise<SiteManifest | null>;
  excerpt?: typeof extractSiteExcerpt;
  capture?: typeof captureSiteScreenshot;
}): Promise<ViewSitePageResult> {
  void input.question;
  const ref = await (input.resolve ?? resolveSiteVersion)({
    userId: input.userId,
    sessionProjectId: input.sessionProjectId,
    siteId: input.siteId,
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.dir !== undefined ? { dir: input.dir } : {}),
  });
  const manifest = await (input.loadManifest ??
    ((siteId: string, dir?: string) => getScopedSite(input.userId, input.sessionProjectId, siteId, dir)))(
    ref.siteId,
    input.dir,
  );
  if (!manifest) throw new Error("Site not found in the current scope.");
  const versionStatus = manifest.versions?.[ref.version]?.status ?? manifest.status;
  if (versionStatus !== "ready") {
    throw new Error(`Site ${ref.siteId} v${ref.version} is ${versionStatus} — nothing viewable yet.`);
  }
  const text = await (input.excerpt ?? extractSiteExcerpt)({ ref, maxChars: 6000 });
  let shot: { imageId: string; capturedAt: string; truncated: boolean; mediaType: string };
  let captureError: string | null = null;
  try {
    shot = await (input.capture ?? captureSiteScreenshot)({
      ref,
      label: text.title || ref.siteId,
      previewPath: `/api/sites/${ref.siteId}/v${ref.version}/preview/index.html`,
      userId: input.userId,
      sessionId: input.sessionId,
      projectId: input.sessionProjectId,
    });
  } catch (error) {
    // Partial result: the excerpt survived, only the screenshot failed.
    // The agent answers from text and may retry the visual.
    captureError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    shot = { imageId: "", capturedAt: "", truncated: false, mediaType: "image/png" };
  }
  return {
    siteId: ref.siteId,
    version: ref.version,
    status: versionStatus,
    title: text.title,
    headings: text.headings,
    excerpt: text.excerpt,
    excerptTruncated: text.truncated,
    imageId: shot.imageId,
    capturedAt: shot.capturedAt,
    viewport: SITE_SCREENSHOT_VIEWPORT,
    fullPage: true,
    truncated: shot.truncated,
    mediaType: shot.mediaType,
    captureError,
    retryable: captureError !== null,
  };
}
