import { describe, expect, it, vi } from "vitest";
import { getApiOrigin } from "../../lib/origins.js";
import {
  BROWSE_FRAME_MIN_INTERVAL_MS,
  BROWSE_MAX_ACTIONS,
  BrowseSessionManager,
  adaptPlaywrightPage,
  browseFrameKey,
  isAllowedBrowseNavigation,
} from "./browse.js";

function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn(async () => undefined),
    title: vi.fn(async () => "Kedai"),
    url: vi.fn(() => "http://localhost:4312/api/sites/s/v1/preview/index.html"),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    clickText: vi.fn(async () => undefined),
    clickSelector: vi.fn(async () => undefined),
    scrollBy: vi.fn(async () => undefined),
    scrollTo: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    startScreencast: vi.fn(async () => undefined),
    stopScreencast: vi.fn(async () => undefined),
    showActions: vi.fn(async () => undefined),
    onDialog: vi.fn(),
    route: vi.fn(),
    ...overrides,
  };
}

function fakeBrowser(page: ReturnType<typeof fakePage>) {
  return { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
}

function manager(
  page: ReturnType<typeof fakePage>,
  ops: {
    now?: () => number;
    writeFrame?: (sessionId: string, base64: string) => Promise<void>;
    clearFrame?: (sessionId: string) => Promise<void>;
    notify?: (event: { state: "started" | "stopped"; siteId: string; label: string }) => Promise<void>;
    release?: () => void;
  } = {},
) {
  return new BrowseSessionManager({
    launch: async () => fakeBrowser(page) as never,
    saveImage: async () => ({ id: "img-1" }),
    writeFrame: ops.writeFrame ?? (async () => undefined),
    clearFrame: ops.clearFrame ?? (async () => undefined),
    notify: ops.notify ?? (async () => undefined),
    acquire: async () => undefined,
    release: ops.release ?? (() => undefined),
    now: ops.now ?? (() => 1_000_000),
    resolve: async ({ siteId, version }) => ({ siteId, version: version ?? 1 }),
  });
}

const OPEN = {
  userId: "u1",
  sessionId: "s1",
  projectId: null,
  siteId: "kedai",
  label: "Kedai",
};

describe("browse session manager", () => {
  it("opens, acts, and closes while publishing live events", async () => {
    const page = fakePage();
    const notify = vi.fn(async () => undefined);
    const writeFrame = vi.fn(async () => undefined);
    const clearFrame = vi.fn(async () => undefined);
    const sessions = manager(page, { notify, writeFrame, clearFrame });
    const opened = await sessions.open(OPEN);
    expect(opened).toMatchObject({
      action: "open",
      sessionState: "open",
      actionsUsed: 1,
      imageId: "img-1",
    });
    expect(page.startScreencast).toHaveBeenCalledTimes(1);
    expect(page.showActions).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ state: "started", siteId: "kedai", label: "Kedai" });

    const clicked = await sessions.act({ ...OPEN, action: "click", text: "Kontak" });
    expect(page.clickText).toHaveBeenCalledWith("Kontak");
    expect(clicked).toMatchObject({ action: "click", actionsUsed: 2, actionsRemaining: 10 });

    const closed = await sessions.act({ ...OPEN, action: "close" });
    expect(closed.sessionState).toBe("closed");
    expect(page.stopScreencast).toHaveBeenCalledTimes(1);
    expect(clearFrame).toHaveBeenCalledWith("s1");
    expect(notify).toHaveBeenLastCalledWith({ state: "stopped", siteId: "kedai", label: "Kedai" });
  });

  it("rejects actions without an open session", async () => {
    const sessions = manager(fakePage());
    await expect(sessions.act({ ...OPEN, action: "scroll" })).rejects.toThrow(/not open/i);
  });

  it("throttles frame writes to one per interval and always writes the first frame", async () => {
    let now = 1_000_000;
    const page = fakePage();
    const writeFrame = vi.fn(async () => undefined);
    const sessions = manager(page, { now: () => now, writeFrame });
    await sessions.open(OPEN);
    const startCalls = (page.startScreencast as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
    const onFrame = startCalls[0]![0] as (frame: { data: Buffer }) => void;
    onFrame({ data: Buffer.from([1]) });
    onFrame({ data: Buffer.from([2]) });
    expect(writeFrame).toHaveBeenCalledTimes(1);
    now += BROWSE_FRAME_MIN_INTERVAL_MS + 1;
    onFrame({ data: Buffer.from([3]) });
    expect(writeFrame).toHaveBeenCalledTimes(2);
  });

  it("closes idle sessions on sweep and clears their frames", async () => {
    let now = 1_000_000;
    const page = fakePage();
    const clearFrame = vi.fn(async () => undefined);
    const sessions = manager(page, { now: () => now, clearFrame });
    await sessions.open(OPEN);
    now += 121_000;
    await sessions.sweepIdle();
    expect(sessions.size()).toBe(0);
    expect(page.close).toHaveBeenCalled();
    expect(clearFrame).toHaveBeenCalledWith("s1");
  });

  it("enforces the action budget", async () => {
    const sessions = manager(fakePage());
    await sessions.open(OPEN);
    for (let i = 0; i < BROWSE_MAX_ACTIONS - 1; i += 1) {
      await sessions.act({ ...OPEN, action: "snapshot" });
    }
    await expect(sessions.act({ ...OPEN, action: "snapshot" })).rejects.toThrow(
      /action budget|12/i,
    );
  });

  it("closes idempotently and releases the capture slot once", async () => {
    const page = fakePage();
    const notify = vi.fn(async () => undefined);
    const clearFrame = vi.fn(async () => undefined);
    const release = vi.fn();
    const sessions = manager(page, { notify, clearFrame, release });
    await sessions.open(OPEN);
    await sessions.closeFor("u1:s1", "test");
    await sessions.closeFor("u1:s1", "test");
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(page.stopScreencast).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(clearFrame).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("keeps the session alive and reports retryable when a screenshot fails", async () => {
    let shots = 0;
    const page = fakePage({
      screenshot: vi.fn(async () => {
        shots += 1;
        if (shots > 1) throw new Error("boom");
        return new Uint8Array([137, 80, 78, 71]);
      }),
    });
    const sessions = manager(page);
    await sessions.open(OPEN);
    const failed = await sessions.act({ ...OPEN, action: "snapshot" });
    expect(failed).toMatchObject({
      imageId: "",
      captureError: "boom",
      retryable: true,
      sessionState: "open",
    });
    expect(sessions.size()).toBe(1);
  });

  it("reports blocked navigations from the page guard", async () => {
    const page = fakePage({ consumeBlocked: vi.fn(() => "https://example.com/") });
    const sessions = manager(page);
    await sessions.open(OPEN);
    const scrolled = await sessions.act({ ...OPEN, action: "scroll" });
    expect(scrolled.blocked).toBe(true);
    expect(scrolled.note).toContain("example.com");
  });
});

describe("browseFrameKey", () => {
  it("namespaces the ephemeral frame per chat session", () => {
    expect(browseFrameKey("s1")).toBe("site-live:s1");
  });
});

describe("playwright page adapter guard", () => {
  function fakeRawPage() {
    const handlers: { route?: (route: never) => void | Promise<void> } = {};
    const raw = {
      goto: vi.fn(async () => undefined),
      title: vi.fn(async () => "Kedai"),
      url: vi.fn(() => "http://localhost:4312/api/sites/s/v1/preview/index.html"),
      screenshot: vi.fn(async () => new Uint8Array([1])),
      close: vi.fn(async () => undefined),
      on: vi.fn(),
      route: vi.fn(async (_pattern: string, handler: (route: never) => void | Promise<void>) => {
        handlers.route = handler;
      }),
      mainFrame: vi.fn(() => "main"),
      getByText: vi.fn(),
      locator: vi.fn(),
      mouse: { wheel: vi.fn(async () => undefined) },
      evaluate: vi.fn(async () => undefined),
      screencast: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        showActions: vi.fn(async () => undefined),
      },
    };
    return { raw, handlers };
  }

  function makeRoute(input: { nav: boolean; url: string }) {
    return {
      request: () => ({
        isNavigationRequest: () => input.nav,
        frame: () => "main",
        url: () => input.url,
      }),
      continue: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
  }

  it("keeps the preview visible on a blocked external navigation", async () => {
    const origin = getApiOrigin();
    const preview = `${origin}/api/sites/s/v1/preview/index.html`;
    const { raw, handlers } = fakeRawPage();
    const page = adaptPlaywrightPage(raw as never);
    await page.goto(preview);
    const blocked = makeRoute({ nav: true, url: "https://example.com/" });
    await handlers.route!(blocked as never);
    // Aborting would commit Chrome's error page and strand the session.
    expect(blocked.continue).toHaveBeenCalledWith({ url: preview });
    expect(blocked.abort).not.toHaveBeenCalled();
    expect(page.consumeBlocked?.()).toBe("https://example.com/");
  });

  it("allows same-origin navigation and in-page anchors", async () => {
    const origin = getApiOrigin();
    const preview = `${origin}/api/sites/s/v1/preview/index.html`;
    const { raw, handlers } = fakeRawPage();
    const page = adaptPlaywrightPage(raw as never);
    await page.goto(preview);
    const anchor = makeRoute({ nav: true, url: `${preview}#kontak` });
    await handlers.route!(anchor as never);
    expect(anchor.continue).toHaveBeenCalledWith();
    expect(anchor.abort).not.toHaveBeenCalled();
    expect(page.consumeBlocked?.()).toBeNull();
  });

  it("blocks external subresources but allows API-origin assets", async () => {
    const origin = getApiOrigin();
    const { raw, handlers } = fakeRawPage();
    adaptPlaywrightPage(raw as never);
    const external = makeRoute({ nav: false, url: "https://cdn.example.com/x.js" });
    await handlers.route!(external as never);
    expect(external.abort).toHaveBeenCalledWith("blockedbyclient");
    const local = makeRoute({ nav: false, url: `${origin}/api/sites/s/v1/preview/app.js` });
    await handlers.route!(local as never);
    expect(local.continue).toHaveBeenCalledWith();
    expect(local.abort).not.toHaveBeenCalled();
  });
});

describe("isAllowedBrowseNavigation", () => {
  const origin = "http://localhost:4312";
  it("allows same-origin navigation and fragments", () => {
    expect(
      isAllowedBrowseNavigation(`${origin}/api/sites/s/v1/preview/index.html`, origin),
    ).toBe(true);
    expect(
      isAllowedBrowseNavigation(`${origin}/api/sites/s/v1/preview/index.html#kontak`, origin),
    ).toBe(true);
  });
  it("blocks other origins and non-http schemes", () => {
    expect(isAllowedBrowseNavigation("https://example.com/", origin)).toBe(false);
    expect(isAllowedBrowseNavigation("file:///etc/passwd", origin)).toBe(false);
    expect(isAllowedBrowseNavigation("about:blank", origin)).toBe(false);
  });
});
