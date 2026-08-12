import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn(),
  getBullmqConnectionOptions: vi.fn(() => ({})),
}));

vi.mock("./service.js", () => ({
  profileConfig: vi.fn(() => ({ enabled: true, delayMs: 1 })),
}));

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    getJob = vi.fn(async () => null);
    add = vi.fn(async () => ({}));
  },
  QueueEvents: class FakeQueueEvents {},
}));

import { getRedis } from "../../lib/redis.js";
import {
  enqueueProfileReconsideration,
  getPendingReconsiderations,
  getProfileQueue,
  removePendingReconsiderations,
} from "./queue.js";

const USER_SCOPE = { kind: "user", userId: "user-1" } as const;

const RECONSIDER_KEY = "profile:reconsider:profile:user:user-1";
const RECONSIDER_TTL_SECONDS = 86400;
const RECONSIDER_MAX_PENDING = 5;

function mockRedis() {
  const redis = {
    lpush: vi.fn(async (_key: string, _value: string) => 1),
    lrange: vi.fn(
      async (_key: string, _start: number, _stop: number): Promise<string[]> =>
        [],
    ),
    ltrim: vi.fn(async () => "OK"),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    lrem: vi.fn(async (_key: string, _count: number, _value: string) => 1),
  };
  vi.mocked(getRedis).mockReturnValue(redis as unknown as Redis);
  return redis;
}

let redis: ReturnType<typeof mockRedis>;

beforeEach(() => {
  vi.resetAllMocks();
  redis = mockRedis();
});

describe("profile reconsideration queue helpers", () => {
  it("parses valid pending entries and skips malformed ones", async () => {
    redis.lrange.mockResolvedValue([
      JSON.stringify({
        deletedSessionId: "session-1",
        snapshot: "snap-a",
        requestedAt: "2026-08-12T10:00:00.000Z",
      }),
      "not json",
      JSON.stringify({ foo: 1 }),
    ]);

    const result = await getPendingReconsiderations(USER_SCOPE);

    expect(redis.lrange).toHaveBeenCalledWith(RECONSIDER_KEY, 0, -1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      deletedSessionId: "session-1",
      snapshot: "snap-a",
      requestedAt: "2026-08-12T10:00:00.000Z",
    });
  });

  it("appends a capped entry, sets the TTL, and always schedules a refresh", async () => {
    await enqueueProfileReconsideration(USER_SCOPE, {
      deletedSessionId: "session-1",
      snapshot: "snap-a",
    });

    expect(redis.lpush).toHaveBeenCalledTimes(1);
    const pushed = JSON.parse(
      redis.lpush.mock.calls[0]![1] as string,
    ) as Record<string, unknown>;
    expect(pushed).toMatchObject({
      deletedSessionId: "session-1",
      snapshot: "snap-a",
    });
    expect(typeof pushed.requestedAt).toBe("string");

    expect(redis.ltrim).toHaveBeenCalledWith(
      RECONSIDER_KEY,
      0,
      RECONSIDER_MAX_PENDING - 1,
    );
    expect(redis.expire).toHaveBeenCalledWith(
      RECONSIDER_KEY,
      RECONSIDER_TTL_SECONDS,
    );

    // enqueueProfileRefresh ran: no pending job (getJob → null) → a fresh
    // profile job is scheduled with the configured delay.
    expect(vi.mocked(getProfileQueue().add)).toHaveBeenCalledWith(
      "profile:user:user-1",
      expect.objectContaining({ kind: "user", userId: "user-1" }),
      { delay: 1 },
    );
  });

  it("removes exactly the consumed entries via lrem", async () => {
    const consumed = [
      {
        deletedSessionId: "session-1",
        snapshot: "snap-a",
        requestedAt: "2026-08-12T10:00:00.000Z",
      },
    ];

    await removePendingReconsiderations(USER_SCOPE, consumed);

    expect(redis.lrem).toHaveBeenCalledWith(
      RECONSIDER_KEY,
      0,
      JSON.stringify(consumed[0]),
    );
  });
});
