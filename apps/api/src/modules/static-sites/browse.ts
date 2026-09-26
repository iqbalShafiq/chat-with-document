import type { BrowseSiteResult } from "@anreal/agent";
import { getApiOrigin } from "../../lib/origins.js";
import { getRedis } from "../../lib/redis.js";
import { getImageStore } from "../images/service.js";
import { readSiteManifest } from "./service.js";
import {
  SITE_SCREENSHOT_VIEWPORT,
  acquireCaptureSlot,
  launchChromium,
  releaseCaptureSlot,
  resolveSiteVersion,
  type ViewingBrowser,
  type ViewingPage,
} from "./viewing.js";

export const BROWSE_IDLE_TTL_MS = 120_000;
export const BROWSE_MAX_ACTIONS = 12;
export const BROWSE_FRAME_MIN_INTERVAL_MS = 300;
export const BROWSE_FRAME_TTL_SECONDS = 30;
const BROWSE_SWEEP_INTERVAL_MS = 30_000;
const BROWSE_NAV_TIMEOUT_MS = 15_000;
const BROWSE_ACTION_TIMEOUT_MS = 10_000;

export function browseFrameKey(sessionId: string): string {
  return `site-live:${sessionId}`;
}

export function isAllowedBrowseNavigation(value: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin === origin;
}

export type SiteLiveViewEvent = {
  state: "started" | "stopped";
  siteId: string;
  label: string;
};

/** High-level page surface (real Playwright in prod, fakes in tests). */
export type BrowsePage = {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: { type?: "png"; timeout?: number }): Promise<Uint8Array>;
  clickText(text: string): Promise<void>;
  clickSelector(selector: string): Promise<void>;
  scrollBy(direction: "up" | "down", viewportHeight: number): Promise<void>;
  scrollTo(to: "top" | "bottom"): Promise<void>;
  close(): Promise<unknown>;
  startScreencast(onFrame: (frame: { data: Buffer }) => void): Promise<void>;
  stopScreencast(): Promise<void>;
  showActions(): Promise<void>;
  /** Returns (and clears) the last blocked top-level navigation, if any. */
  consumeBlocked?(): string | null;
};

export type BrowseSessionBrowser = {
  newPage(): Promise<BrowsePage>;
  close(): Promise<unknown>;
};

export type BrowseSessionsDeps = {
  launch?: () => Promise<BrowseSessionBrowser>;
  saveImage?: (args: {
    userId: string;
    sessionId: string;
    projectId: string | null;
    buffer: Uint8Array;
    label: string;
  }) => Promise<{ id: string }>;
  writeFrame?: (sessionId: string, base64: string) => Promise<void>;
  clearFrame?: (sessionId: string) => Promise<void>;
  /** Single-argument by design: the manager owns the session id. */
  notify?: (event: SiteLiveViewEvent) => Promise<void>;
  acquire?: () => Promise<void>;
  release?: () => void;
  now?: () => number;
  resolve?: (input: {
    userId: string;
    sessionProjectId: string | null;
    siteId: string;
    version?: number;
  }) => Promise<{ siteId: string; version: number; label?: string }>;
};

export type BrowseActInput = {
  userId: string;
  sessionId: string;
  projectId: string | null;
  siteId: string;
  version?: number;
  label?: string;
  action: BrowseSiteResult["action"];
  selector?: string;
  text?: string;
  to?: "top" | "bottom";
};

type BrowseSession = {
  key: string;
  userId: string;
  sessionId: string;
  projectId: string | null;
  siteId: string;
  version: number;
  label: string;
  page: BrowsePage;
  browser: BrowseSessionBrowser;
  notify: (event: SiteLiveViewEvent) => Promise<void>;
  actionsUsed: number;
  lastActionAt: number;
  lastFrameWriteAt: number;
  closed: boolean;
};

/**
 * Module-level notifier bridge installed by the chat wiring (Task 4). Kept
 * dynamic so this module has no import-time dependency on the chat module.
 */
let liveNotifier: ((sessionId: string, event: SiteLiveViewEvent) => Promise<void>) | null = null;

export function setBrowseLiveNotifier(
  notifier: ((sessionId: string, event: SiteLiveViewEvent) => Promise<void>) | null,
): void {
  liveNotifier = notifier;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultResolve(input: {
  userId: string;
  sessionProjectId: string | null;
  siteId: string;
  version?: number;
}): Promise<{ siteId: string; version: number; label?: string }> {
  const ref = await resolveSiteVersion({
    userId: input.userId,
    sessionProjectId: input.sessionProjectId,
    siteId: input.siteId,
    ...(input.version !== undefined ? { version: input.version } : {}),
  });
  const manifest = await readSiteManifest(ref.siteId).catch(() => null);
  const label = manifest?.brief?.siteName;
  return { ...ref, ...(label ? { label } : {}) };
}

export class BrowseSessionManager {
  private readonly sessions = new Map<string, BrowseSession>();
  private readonly deps: BrowseSessionsDeps;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(deps: BrowseSessionsDeps = {}) {
    this.deps = deps;
  }

  size(): number {
    return this.sessions.size;
  }

  async open(input: Omit<BrowseActInput, "action">): Promise<BrowseSiteResult> {
    const key = this.keyFor(input.userId, input.sessionId);
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) {
      return this.captureResult(
        existing,
        "open",
        "Browse session already open — returning a fresh snapshot.",
      );
    }
    const resolved = await (this.deps.resolve ?? defaultResolve)({
      userId: input.userId,
      sessionProjectId: input.projectId,
      siteId: input.siteId,
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    const label = input.label ?? resolved.label ?? resolved.siteId;
    await (this.deps.acquire ?? acquireCaptureSlot)();
    let browser: BrowseSessionBrowser | null = null;
    let session: BrowseSession | null = null;
    try {
      browser = await (this.deps.launch ?? (() => createPlaywrightBrowseBrowser()))();
      const page = await browser.newPage();
      await page.goto(
        `${getApiOrigin()}/api/sites/${resolved.siteId}/v${resolved.version}/preview/index.html`,
        { waitUntil: "networkidle", timeout: BROWSE_NAV_TIMEOUT_MS },
      );
      session = {
        key,
        userId: input.userId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        siteId: resolved.siteId,
        version: resolved.version,
        label,
        page,
        browser,
        notify: this.deps.notify ?? ((event) => this.emitLive(input.sessionId, event)),
        actionsUsed: 1,
        lastActionAt: this.now(),
        lastFrameWriteAt: 0,
        closed: false,
      };
      this.sessions.set(key, session);
      this.ensureSweeper();
      await this.startLive(session);
      return await this.captureResult(session, "open");
    } catch (error) {
      if (session) {
        this.sessions.delete(key);
        session.closed = true;
        await this.stopLive(session, "open failed");
      }
      await browser?.close().catch(() => undefined);
      (this.deps.release ?? releaseCaptureSlot)();
      throw error;
    }
  }

  async act(input: BrowseActInput): Promise<BrowseSiteResult> {
    if (input.action === "open") return this.open(input);
    const session = this.sessions.get(this.keyFor(input.userId, input.sessionId));
    if (!session || session.closed) {
      throw new Error("Browse session is not open — call open first.");
    }
    if (input.action === "close") {
      const result = await this.captureResult(session, "close", "Browse session closed.");
      await this.closeSession(session, "agent requested close");
      return { ...result, sessionState: "closed" };
    }
    if (session.actionsUsed >= BROWSE_MAX_ACTIONS) {
      throw new Error(`Browse action budget (${BROWSE_MAX_ACTIONS}) reached — call close.`);
    }
    if (input.action === "click") {
      const hasSelector = typeof input.selector === "string" && input.selector.length > 0;
      const hasText = typeof input.text === "string" && input.text.length > 0;
      if (hasSelector === hasText) {
        throw new Error("browse_site click needs exactly one of selector or text.");
      }
    }
    session.actionsUsed += 1;
    session.lastActionAt = this.now();
    if (input.action === "scroll") {
      if (input.to) await session.page.scrollTo(input.to);
      else await session.page.scrollBy("down", SITE_SCREENSHOT_VIEWPORT.height);
    } else if (input.action === "click") {
      if (input.text) await session.page.clickText(input.text);
      else await session.page.clickSelector(input.selector!);
    }
    return this.captureResult(session, input.action);
  }

  async closeFor(key: string, reason: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session || session.closed) return;
    await this.closeSession(session, reason);
  }

  async sweepIdle(): Promise<void> {
    const now = this.now();
    for (const session of [...this.sessions.values()]) {
      if (session.closed) continue;
      if (now - session.lastActionAt >= BROWSE_IDLE_TTL_MS) {
        await this.closeSession(session, "idle timeout");
      }
    }
  }

  private keyFor(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.sweepIdle();
    }, BROWSE_SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  private async emitLive(sessionId: string, event: SiteLiveViewEvent): Promise<void> {
    try {
      await liveNotifier?.(sessionId, event);
    } catch (error) {
      console.warn(`[browse] live event skipped: ${errorMessage(error)}`);
    }
  }

  private async startLive(session: BrowseSession): Promise<void> {
    try {
      await session.page.startScreencast((frame) => this.handleFrame(session, frame.data));
      await session.page.showActions();
    } catch (error) {
      // Live view must never fail the agent's browsing session.
      console.warn(`[browse] screencast unavailable: ${errorMessage(error)}`);
    }
    await session.notify({ state: "started", siteId: session.siteId, label: session.label });
  }

  private handleFrame(session: BrowseSession, data: Buffer): void {
    const now = this.now();
    if (now - session.lastFrameWriteAt < BROWSE_FRAME_MIN_INTERVAL_MS) return;
    session.lastFrameWriteAt = now;
    const base64 = Buffer.from(data).toString("base64");
    void (this.deps.writeFrame ?? defaultWriteFrame)(session.sessionId, base64).catch((error) => {
      console.warn(`[browse] frame write skipped: ${errorMessage(error)}`);
    });
  }

  private async stopLive(session: BrowseSession, reason: string): Promise<void> {
    try {
      await session.page.stopScreencast();
    } catch {
      // Page may already be gone; stopping is best-effort.
    }
    try {
      await (this.deps.clearFrame ?? defaultClearFrame)(session.sessionId);
    } catch (error) {
      console.warn(`[browse] frame clear skipped: ${errorMessage(error)}`);
    }
    await session.notify({ state: "stopped", siteId: session.siteId, label: session.label });
    void reason;
  }

  private async closeSession(session: BrowseSession, reason: string): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.key);
    await this.stopLive(session, reason);
    await session.page.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    (this.deps.release ?? releaseCaptureSlot)();
  }

  private async captureResult(
    session: BrowseSession,
    action: BrowseSiteResult["action"],
    note: string | null = null,
  ): Promise<BrowseSiteResult> {
    const blockedUrl = session.page.consumeBlocked?.() ?? null;
    const title = await session.page.title().catch(() => session.label);
    const url = (() => {
      try {
        return session.page.url();
      } catch {
        return "";
      }
    })();
    let imageId = "";
    let captureError: string | null = null;
    try {
      const buffer = Buffer.from(await session.page.screenshot({ type: "png", timeout: BROWSE_NAV_TIMEOUT_MS }));
      const saved = await (this.deps.saveImage ?? defaultSaveImage)({
        userId: session.userId,
        sessionId: session.sessionId,
        projectId: session.projectId,
        buffer,
        label: session.label,
      });
      imageId = saved.id;
    } catch (error) {
      captureError = errorMessage(error).slice(0, 500);
    }
    return {
      siteId: session.siteId,
      version: session.version,
      action,
      title,
      url,
      imageId,
      blocked: blockedUrl !== null,
      note: blockedUrl
        ? `Navigation to ${blockedUrl} was blocked — only the local preview origin is allowed.`
        : note,
      actionsUsed: session.actionsUsed,
      actionsRemaining: Math.max(0, BROWSE_MAX_ACTIONS - session.actionsUsed),
      sessionState: session.closed ? "closed" : "open",
      captureError,
      retryable: captureError !== null,
    };
  }
}

async function defaultWriteFrame(sessionId: string, base64: string): Promise<void> {
  await getRedis().set(browseFrameKey(sessionId), base64, "EX", BROWSE_FRAME_TTL_SECONDS);
}

async function defaultClearFrame(sessionId: string): Promise<void> {
  await getRedis().del(browseFrameKey(sessionId));
}

async function defaultSaveImage(args: {
  userId: string;
  sessionId: string;
  projectId: string | null;
  buffer: Uint8Array;
  label: string;
}): Promise<{ id: string }> {
  const saved = await getImageStore().saveGeneratedImage({
    userId: args.userId,
    sessionId: args.sessionId,
    projectId: args.projectId,
    buffer: args.buffer,
    mediaType: "image/png",
    modelId: "site-screenshot",
    prompt: args.label,
    caption: `Live browse ${args.label}`,
    width: SITE_SCREENSHOT_VIEWPORT.width,
    height: SITE_SCREENSHOT_VIEWPORT.height,
    source: "site-screenshot",
  });
  return { id: saved.id };
}

// --- Playwright adapter -------------------------------------------------

type RawRoute = {
  request(): { isNavigationRequest(): boolean; frame(): unknown; url(): string };
  abort(errorCode: string): Promise<void>;
  continue(): Promise<void>;
};

type RawPlaywrightPage = ViewingPage & {
  title(): Promise<string>;
  url(): string;
  on(event: "dialog", listener: (dialog: { dismiss(): Promise<void> }) => void): void;
  on(event: "download", listener: (download: { cancel(): Promise<void> }) => void): void;
  on(event: "popup", listener: (popup: { close(): Promise<void> }) => void): void;
  route(pattern: string, handler: (route: RawRoute) => void | Promise<void>): Promise<void>;
  mainFrame(): unknown;
  getByText(
    text: string,
    options?: { exact?: boolean },
  ): { first(): { click(options?: { timeout?: number }): Promise<void> } };
  locator(selector: string): { first(): { click(options?: { timeout?: number }): Promise<void> } };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  evaluate<T>(fn: (arg: T) => void, arg: T): Promise<unknown>;
  screencast: {
    start(options: {
      size: { width: number; height: number };
      quality: number;
      onFrame: (frame: { data: Buffer }) => void;
    }): Promise<void>;
    stop(): Promise<void>;
    showActions(options: { cursor: "pointer" }): Promise<unknown>;
  };
};

const BROWSE_FRAME_SIZE = { width: 1024, height: 640 };
const BROWSE_FRAME_QUALITY = 60;

export function adaptPlaywrightPage(raw: RawPlaywrightPage): BrowsePage {
  let blockedUrl: string | null = null;
  raw.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });
  raw.on("download", (download) => {
    void download.cancel().catch(() => undefined);
  });
  raw.on("popup", (popup) => {
    void popup.close().catch(() => undefined);
  });
  void raw.route("**/*", (route) => {
    const request = route.request();
    if (
      request.isNavigationRequest() &&
      request.frame() === raw.mainFrame() &&
      !isAllowedBrowseNavigation(request.url(), getApiOrigin())
    ) {
      blockedUrl = request.url();
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return {
    goto: (url, opts) => raw.goto(url, opts),
    title: () => raw.title(),
    url: () => raw.url(),
    screenshot: (opts) =>
      raw.screenshot({
        type: opts?.type ?? "png",
        fullPage: false,
        timeout: opts?.timeout ?? BROWSE_NAV_TIMEOUT_MS,
      }),
    clickText: async (text) => {
      await raw.getByText(text, { exact: false }).first().click({ timeout: BROWSE_ACTION_TIMEOUT_MS });
    },
    clickSelector: async (selector) => {
      await raw.locator(selector).first().click({ timeout: BROWSE_ACTION_TIMEOUT_MS });
    },
    scrollBy: async (direction, viewportHeight) => {
      await raw.mouse.wheel(0, direction === "down" ? viewportHeight : -viewportHeight);
    },
    scrollTo: async (to) => {
      await raw.evaluate((target: string) => {
        window.scrollTo(0, target === "top" ? 0 : document.body.scrollHeight);
      }, to);
    },
    close: () => raw.close(),
    startScreencast: (onFrame) =>
      raw.screencast.start({
        size: BROWSE_FRAME_SIZE,
        quality: BROWSE_FRAME_QUALITY,
        onFrame: (frame) => onFrame({ data: frame.data }),
      }),
    stopScreencast: () => raw.screencast.stop(),
    showActions: async () => {
      await raw.screencast.showActions({ cursor: "pointer" });
    },
    consumeBlocked: () => {
      const value = blockedUrl;
      blockedUrl = null;
      return value;
    },
  };
}

export async function createPlaywrightBrowseBrowser(
  launch: () => Promise<ViewingBrowser> = launchChromium,
): Promise<BrowseSessionBrowser> {
  const browser = await launch();
  return {
    close: () => browser.close(),
    newPage: async () => {
      const raw = (await browser.newPage({
        viewport: SITE_SCREENSHOT_VIEWPORT,
      })) as unknown as RawPlaywrightPage;
      return adaptPlaywrightPage(raw);
    },
  };
}

let singleton: BrowseSessionManager | null = null;

export function getBrowseSessions(deps: BrowseSessionsDeps = {}): BrowseSessionManager {
  singleton ??= new BrowseSessionManager(deps);
  return singleton;
}
