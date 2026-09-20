import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/redis.js", () => ({
  getBullmqConnectionOptions: vi.fn(() => ({})),
}));

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    add = vi.fn(async () => ({}));
  },
}));

import {
  enqueueSessionTitle,
  getSessionTitleQueue,
  sessionTitleJobId,
} from "./queue.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session title queue", () => {
  it("dedupes by session id and forwards the job payload", async () => {
    await enqueueSessionTitle({
      sessionId: "session-1",
      userId: "user-1",
      seed: "Halo dunia",
      prompt: "Halo dunia, tolong bantu analisis",
    });

    expect(sessionTitleJobId("session-1")).toBe("session-title:session-1");
    expect(vi.mocked(getSessionTitleQueue().add)).toHaveBeenCalledWith(
      "session-title:session-1",
      {
        sessionId: "session-1",
        userId: "user-1",
        seed: "Halo dunia",
        prompt: "Halo dunia, tolong bantu analisis",
      },
    );
  });

  it("supports an injected queue override", async () => {
    const add = vi.fn(async () => ({}) as never);
    await enqueueSessionTitle(
      { sessionId: "s2", userId: "u2", seed: "x", prompt: "x" },
      { add },
    );
    expect(add).toHaveBeenCalledWith(
      "session-title:s2",
      expect.objectContaining({ sessionId: "s2" }),
    );
  });
});
