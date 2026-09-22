import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/redis.js", () => ({
  getBullmqConnectionOptions: vi.fn(() => ({})),
}));

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    add = vi.fn(async () => ({}));
    getJob = vi.fn(async () => null);
  },
}));

vi.mock("./service.js", () => ({
  siteBuildEnabled: vi.fn(() => true),
}));

import {
  enqueueSiteBuild,
  getSiteBuildQueue,
  siteBuildJobId,
} from "./queue.js";
import { siteBuildEnabled } from "./service.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(siteBuildEnabled).mockReturnValue(true);
});

describe("site build queue", () => {
  it("dedupes by site id and version and forwards the payload", async () => {
    await enqueueSiteBuild({
      siteId: "site-1",
      sessionId: "session-1",
      userId: "user-1",
      prompt: "bikinkan landing page kopi",
      brief: {
        siteName: "Kopi Senja",
        audience: "pecinta kopi",
        cta: "Pesan",
        sections: ["hero", "kontak"],
        vibe: "hangat",
      },
      version: 2,
    });

    expect(siteBuildJobId("site-1", 2)).toBe("site-build:site-1:v2");
    expect(vi.mocked(getSiteBuildQueue().add)).toHaveBeenCalledWith(
      "site-build:site-1:v2",
      {
        siteId: "site-1",
        sessionId: "session-1",
        userId: "user-1",
        prompt: "bikinkan landing page kopi",
        brief: {
          siteName: "Kopi Senja",
          audience: "pecinta kopi",
          cta: "Pesan",
          sections: ["hero", "kontak"],
          vibe: "hangat",
        },
        version: 2,
      },
      { jobId: "site-build:site-1:v2" },
    );
  });

  it("retries the existing job when the same version already failed", async () => {
    const retry = vi.fn(async () => undefined);
    const queue = getSiteBuildQueue();
    vi.mocked(queue.getJob).mockResolvedValueOnce({
      getState: async () => "failed",
      retry,
    } as never);
    await enqueueSiteBuild({
      siteId: "site-1",
      sessionId: "session-1",
      userId: "user-1",
      prompt: "bikinkan landing page kopi",
      brief: null,
      version: 2,
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(vi.mocked(queue.add)).not.toHaveBeenCalled();
  });

  it("does nothing when the builder is disabled", async () => {
    vi.mocked(siteBuildEnabled).mockReturnValue(false);
    await enqueueSiteBuild({
      siteId: "s",
      sessionId: "s",
      userId: "u",
      prompt: "x",
      brief: null,
      version: 1,
    });
    expect(vi.mocked(getSiteBuildQueue().add)).not.toHaveBeenCalled();
  });
});
