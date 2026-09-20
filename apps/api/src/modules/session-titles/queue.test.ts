import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  queueCtorCalls: [] as unknown[][],
  sessionTitleEnabled: vi.fn(() => true),
}));

vi.mock("../../lib/redis.js", () => ({
  getBullmqConnectionOptions: vi.fn(() => ({})),
}));

vi.mock("./service.js", () => ({
  sessionTitleEnabled: f.sessionTitleEnabled,
}));

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    add = vi.fn(async () => ({}));

    constructor(...args: unknown[]) {
      f.queueCtorCalls.push(args);
    }
  },
}));

import {
  SESSION_TITLE_QUEUE,
  enqueueSessionTitle,
  getSessionTitleQueue,
  sessionTitleJobId,
} from "./queue.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session title queue", () => {
  it("configures bounded retries and bounded job retention", () => {
    getSessionTitleQueue();

    expect(f.queueCtorCalls).toHaveLength(1);
    const [name, options] = f.queueCtorCalls[0] as [
      string,
      { defaultJobOptions: unknown },
    ];
    expect(name).toBe(SESSION_TITLE_QUEUE);
    expect(options.defaultJobOptions).toEqual({
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 200,
      removeOnFail: true,
    });
  });

  it("dedupes by session id and forwards the job payload", async () => {
    await enqueueSessionTitle({
      sessionId: "session-1",
      userId: "user-1",
      seed: "Halo dunia",
      prompt: "Halo dunia, tolong bantu analisis",
    });

    expect(sessionTitleJobId("session-1")).toBe("session-title-session-1");
    expect(sessionTitleJobId("session-1")).not.toContain(":");
    expect(vi.mocked(getSessionTitleQueue().add)).toHaveBeenCalledWith(
      "session-title-session-1",
      {
        sessionId: "session-1",
        userId: "user-1",
        seed: "Halo dunia",
        prompt: "Halo dunia, tolong bantu analisis",
      },
      { jobId: "session-title-session-1" },
    );
  });

  it("supports an injected queue override", async () => {
    const add = vi.fn(async () => ({}) as never);
    await enqueueSessionTitle(
      { sessionId: "s2", userId: "u2", seed: "x", prompt: "x" },
      { add },
    );
    expect(add).toHaveBeenCalledWith(
      "session-title-s2",
      expect.objectContaining({ sessionId: "s2" }),
      { jobId: "session-title-s2" },
    );
  });

  it("skips the producer entirely while TITLE_ENABLED is false", async () => {
    f.sessionTitleEnabled.mockReturnValueOnce(false);
    const add = vi.fn(async () => ({}) as never);

    await enqueueSessionTitle(
      { sessionId: "s3", userId: "u3", seed: "x", prompt: "x" },
      { add },
    );

    expect(add).not.toHaveBeenCalled();
    expect(vi.mocked(getSessionTitleQueue().add)).not.toHaveBeenCalled();
  });
});
