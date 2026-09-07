import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn(),
}));

vi.mock("../../lib/resumable-stream-store.js", () => ({
  getStreamStore: vi.fn(),
}));

vi.mock("./run-queue.js", async () => {
  const { getRedis } = await import("../../lib/redis.js");
  const ACTIVE_RUN_KEY = (sessionId: string) => `rs-active:${sessionId}`;
  return {
    ACTIVE_RUN_KEY,
    getChatRunQueue: vi.fn(),
    releaseActiveRun: vi.fn(async (sessionId: string, streamId: string) => {
      const redis = getRedis();
      const current = await redis.get(ACTIVE_RUN_KEY(sessionId));
      if (current === streamId) await redis.del(ACTIVE_RUN_KEY(sessionId));
    }),
  };
});

vi.mock("../profiling/queue.js", () => ({
  enqueueProfileReconsideration: vi.fn(async () => {}),
}));

vi.mock("../profiling/service.js", () => ({
  profileConfig: vi.fn(),
}));

vi.mock("../../utils/prisma.js", () => ({
  prisma: {
    agentMemorySession: { findUnique: vi.fn() },
    agentMemoryMessage: { findMany: vi.fn() },
  },
}));

vi.mock("./chat-session.js", () => ({
  ChatSessionNotFoundError: class ChatSessionNotFoundError extends Error {
    readonly code = "CHAT_SESSION_NOT_FOUND";
    constructor(message = "Chat session not found") {
      super(message);
      this.name = "ChatSessionNotFoundError";
    }
  },
  TITLE_MAX: 48,
  getChatSession: vi.fn(),
  deleteChatSessionsHard: vi.fn(async () => 1),
}));

import type { ResumableStreamStoreWithMeta } from "../../lib/resumable-stream-store.js";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { prisma } from "../../utils/prisma.js";
import { enqueueProfileReconsideration } from "../profiling/queue.js";
import { profileConfig } from "../profiling/service.js";
import type { ProfileConfig } from "../profiling/service.js";
import {
  ChatSessionNotFoundError,
  deleteChatSessionsHard,
  getChatSession,
} from "./chat-session.js";
import type { ChatSessionRow } from "./chat-session.js";
import { getChatRunQueue } from "./run-queue.js";
import {
  deleteChatSession,
  SessionRunActiveError,
  stopActiveRunForSession,
} from "./session-delete.js";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const STREAM_ID = "stream-1";

const RUN_KEY = `rs-active:${SESSION_ID}`;

function chatSessionRow(
  overrides: Partial<ChatSessionRow> = {},
): ChatSessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    projectId: null,
    title: null,
    createdAt: new Date("2026-08-12T10:00:00.000Z"),
    updatedAt: new Date("2026-08-12T10:00:00.000Z"),
    ...overrides,
  };
}

function createFakes() {
  const redisGet = vi.fn();
  const redisDel = vi.fn();
  vi.mocked(getRedis).mockReturnValue({
    get: redisGet,
    del: redisDel,
  } as unknown as Redis);

  const storeStatus = vi.fn();
  const setStopFlag = vi.fn(async () => undefined);
  const storeClose = vi.fn(async () => undefined);
  vi.mocked(getStreamStore).mockReturnValue({
    status: storeStatus,
    setStopFlag,
    close: storeClose,
  } as unknown as ResumableStreamStoreWithMeta);

  const queueGetJob = vi.fn();
  vi.mocked(getChatRunQueue).mockReturnValue({
    getJob: queueGetJob,
  } as unknown as ReturnType<typeof getChatRunQueue>);

  return {
    redisGet,
    redisDel,
    storeStatus,
    setStopFlag,
    storeClose,
    queueGetJob,
  };
}

let fakes: ReturnType<typeof createFakes>;

beforeEach(() => {
  vi.resetAllMocks();
  fakes = createFakes();
  vi.mocked(profileConfig).mockReturnValue({
    enabled: true,
    delayMs: 1,
    concurrency: 1,
    model: {} as never,
  } as ProfileConfig);
  vi.mocked(prisma.agentMemorySession.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.agentMemoryMessage.findMany).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stopActiveRunForSession", () => {
  it("returns false without touching the store when no lock exists", async () => {
    fakes.redisGet.mockResolvedValue(null);

    await expect(
      stopActiveRunForSession(USER_ID, SESSION_ID),
    ).resolves.toBe(false);

    expect(fakes.storeStatus).not.toHaveBeenCalled();
    expect(fakes.redisDel).not.toHaveBeenCalled();
    expect(fakes.setStopFlag).not.toHaveBeenCalled();
  });

  it("drops a stale lock when the stream is not running", async () => {
    fakes.redisGet.mockResolvedValue(STREAM_ID);
    fakes.storeStatus.mockResolvedValue({ status: "missing", lastEventId: 0 });

    await expect(
      stopActiveRunForSession(USER_ID, SESSION_ID),
    ).resolves.toBe(false);

    expect(fakes.redisDel).toHaveBeenCalledWith(RUN_KEY);
    expect(fakes.setStopFlag).not.toHaveBeenCalled();
  });

  it("drops a stale lock when the run job is in a terminal state", async () => {
    fakes.redisGet.mockResolvedValue(STREAM_ID);
    fakes.storeStatus.mockResolvedValue({ status: "running", lastEventId: 0 });
    fakes.queueGetJob.mockResolvedValue({ getState: async () => "completed" });

    await expect(
      stopActiveRunForSession(USER_ID, SESSION_ID),
    ).resolves.toBe(false);

    expect(fakes.redisDel).toHaveBeenCalledWith(RUN_KEY);
    expect(fakes.setStopFlag).not.toHaveBeenCalled();
  });

  it("sets the stop flag and waits for the native worker to clear the lock", async () => {
    fakes.redisGet.mockResolvedValueOnce(STREAM_ID).mockResolvedValue(null);
    fakes.storeStatus.mockResolvedValue({ status: "running", lastEventId: 0 });
    fakes.queueGetJob.mockResolvedValue({ getState: async () => "active" });

    await expect(
      stopActiveRunForSession(USER_ID, SESSION_ID),
    ).resolves.toBe(true);

    expect(fakes.setStopFlag).toHaveBeenCalledWith(STREAM_ID);
    expect(fakes.redisDel).not.toHaveBeenCalled();
  });

  it("throws SessionRunActiveError when the lock is never released", async () => {
    vi.useFakeTimers();
    fakes.redisGet.mockResolvedValue(STREAM_ID);
    fakes.storeStatus.mockResolvedValue({ status: "running", lastEventId: 0 });
    fakes.queueGetJob.mockResolvedValue({
      getState: async () => "active",
      remove: async () => {
        throw new Error("cannot remove active job");
      },
    });

    const promise = stopActiveRunForSession(USER_ID, SESSION_ID);
    const assertion = expect(promise).rejects.toThrow(SessionRunActiveError);
    // Let the chain reach the first poll sleep, then blow through the 12s
    // settle deadline with fake timers (real RUN_SETTLE_TIMEOUT_MS preserved).
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(12_001);
    await assertion;
  });

  it("removes a waiting job and releases the lock without waiting", async () => {
    fakes.redisGet.mockResolvedValue(STREAM_ID);
    fakes.storeStatus.mockResolvedValue({ status: "running", lastEventId: 0 });
    const remove = vi.fn(async () => undefined);
    fakes.queueGetJob.mockResolvedValue({
      getState: async () => "waiting",
      remove,
    });

    await expect(
      stopActiveRunForSession(USER_ID, SESSION_ID),
    ).resolves.toBe(true);

    expect(remove).toHaveBeenCalled();
    expect(fakes.setStopFlag).toHaveBeenCalledWith(STREAM_ID);
    expect(fakes.storeClose).toHaveBeenCalledWith({
      streamId: STREAM_ID,
      status: "error",
    });
    expect(fakes.redisDel).toHaveBeenCalledWith(RUN_KEY);
  });

  it("reclaims a stale lock when no run job exists after a brief settle", async () => {
    fakes.redisGet.mockResolvedValue(STREAM_ID);
    fakes.storeStatus.mockResolvedValue({ status: "running", lastEventId: 0 });
    fakes.queueGetJob.mockResolvedValue(null);

    await expect(
      stopActiveRunForSession(USER_ID, SESSION_ID),
    ).resolves.toBe(true);

    expect(fakes.setStopFlag).toHaveBeenCalledWith(STREAM_ID);
    expect(fakes.storeClose).toHaveBeenCalledWith({
      streamId: STREAM_ID,
      status: "error",
    });
    expect(fakes.redisDel).toHaveBeenCalledWith(RUN_KEY);
  });
});

describe("deleteChatSession", () => {
  it("propagates the ownership 404 without deleting or enqueuing", async () => {
    vi.mocked(getChatSession).mockRejectedValue(new ChatSessionNotFoundError());

    await expect(deleteChatSession(USER_ID, SESSION_ID)).rejects.toThrow(
      ChatSessionNotFoundError,
    );

    expect(deleteChatSessionsHard).not.toHaveBeenCalled();
    expect(enqueueProfileReconsideration).not.toHaveBeenCalled();
    expect(fakes.redisGet).not.toHaveBeenCalled();
  });

  it("deletes and enqueues reconsideration for user + project scopes", async () => {
    vi.mocked(getChatSession).mockResolvedValue(
      chatSessionRow({ projectId: "project-1" }),
    );
    fakes.redisGet.mockResolvedValue(null);
    vi.mocked(prisma.agentMemorySession.findUnique).mockResolvedValue({
      id: "memory-1",
    } as never);
    vi.mocked(prisma.agentMemoryMessage.findMany).mockResolvedValue([
      {
        createdAt: new Date("2026-08-12T10:00:00.000Z"),
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello profile" }],
        },
      },
    ] as never);

    await expect(deleteChatSession(USER_ID, SESSION_ID)).resolves.toEqual({
      deleted: true,
      hadActiveRun: false,
    });

    expect(deleteChatSessionsHard).toHaveBeenCalledWith(USER_ID, [SESSION_ID]);
    expect(enqueueProfileReconsideration).toHaveBeenCalledTimes(2);
    expect(enqueueProfileReconsideration).toHaveBeenCalledWith(
      { kind: "user", userId: USER_ID },
      {
        deletedSessionId: SESSION_ID,
        snapshot: expect.stringContaining("Hello profile"),
      },
    );
    expect(enqueueProfileReconsideration).toHaveBeenCalledWith(
      { kind: "project", userId: USER_ID, projectId: "project-1" },
      {
        deletedSessionId: SESSION_ID,
        snapshot: expect.stringContaining("Hello profile"),
      },
    );
  });

  it("does not enqueue reconsideration when the snapshot is empty", async () => {
    vi.mocked(getChatSession).mockResolvedValue(chatSessionRow());
    fakes.redisGet.mockResolvedValue(null);
    vi.mocked(prisma.agentMemorySession.findUnique).mockResolvedValue(null);

    await expect(deleteChatSession(USER_ID, SESSION_ID)).resolves.toEqual({
      deleted: true,
      hadActiveRun: false,
    });

    expect(deleteChatSessionsHard).toHaveBeenCalledWith(USER_ID, [SESSION_ID]);
    expect(enqueueProfileReconsideration).not.toHaveBeenCalled();
  });

  it("throws SessionRunActiveError when the run is re-acquired before the delete", async () => {
    vi.mocked(getChatSession).mockResolvedValue(chatSessionRow());
    // stopActiveRunForSession sees no lock; the relock check (after the
    // snapshot capture) finds one — a stale second tab started a new run.
    fakes.redisGet.mockResolvedValueOnce(null).mockResolvedValue(STREAM_ID);
    vi.mocked(prisma.agentMemorySession.findUnique).mockResolvedValue({
      id: "memory-1",
    } as never);

    await expect(deleteChatSession(USER_ID, SESSION_ID)).rejects.toThrow(
      SessionRunActiveError,
    );

    expect(deleteChatSessionsHard).not.toHaveBeenCalled();
    expect(enqueueProfileReconsideration).not.toHaveBeenCalled();
  });
});
