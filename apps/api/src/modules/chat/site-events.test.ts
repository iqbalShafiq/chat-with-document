import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  redisGet: vi.fn(),
  append: vi.fn(),
  map: vi.fn((appEvent: unknown) => ({ mapped: appEvent })),
  toResumable: vi.fn((event: unknown) => ({ resumable: event })),
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: () => ({ get: f.redisGet }),
}));

vi.mock("../../lib/resumable-stream-store.js", () => ({
  getStreamStore: () => ({ append: f.append }),
}));

vi.mock("./client-events.js", () => ({
  mapChatAppEvent: f.map,
  toChatResumableEvent: f.toResumable,
}));

vi.mock("./run-queue.js", () => ({
  ACTIVE_RUN_KEY: (sessionId: string) => `rs-active:${sessionId}`,
}));

import { publishSiteBuildEvent } from "./site-events.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publishSiteBuildEvent", () => {
  it("appends progress events to the session active stream", async () => {
    f.redisGet.mockResolvedValue("stream-1");
    f.append.mockResolvedValue({ eventId: 1 });

    await publishSiteBuildEvent({
      sessionId: "session-1",
      appEvent: {
        type: "site_build_progress",
        siteId: "site-1",
        version: 1,
        phase: "building",
        message: "Membangun hero.",
      },
    });

    expect(f.redisGet).toHaveBeenCalledWith("rs-active:session-1");
    expect(f.map).toHaveBeenCalledWith(
      {
        type: "site_build_progress",
        siteId: "site-1",
        version: 1,
        phase: "building",
        message: "Membangun hero.",
      },
      { runId: "stream-1" },
    );
    expect(f.append).toHaveBeenCalledOnce();
  });

  it("does nothing without an active stream", async () => {
    f.redisGet.mockResolvedValue(null);
    await publishSiteBuildEvent({
      sessionId: "session-1",
      appEvent: {
        type: "site_build_ready",
        siteId: "site-1",
        version: 1,
        previewUrl: null,
        screenshotUrl: null,
        downloadUrl: "/api/sites/site-1/v1/download",
      },
    });
    expect(f.append).not.toHaveBeenCalled();
  });
});
