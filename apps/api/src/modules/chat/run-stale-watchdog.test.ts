import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { ResumableStreamState } from "@anvia/server";
import {
  closeStaleRun,
  sweepStaleRuns,
  type RunStaleWatchdogOptions,
  type WatchdogStore,
} from "./run-stale-watchdog.js";
import { RUN_OWNER_WAL_KEY, RUN_CREATED_KEY } from "./run-worker.js";

function fakeStore(): WatchdogStore & { events: string[]; closed: { status: string }[] } {
  const events: string[] = [];
  const closed: { status: string }[] = [];
  return {
    events,
    closed,
    async status({ streamId }) {
      void streamId;
      const state: ResumableStreamState = { status: "running", lastEventId: 0 };
      return state;
    },
    async append({ event }) {
      events.push((event as { event: { type: string } }).event.type);
    },
    async close({ status }) {
      const state: ResumableStreamState = { status, lastEventId: 0 };
      closed.push({ status });
      return state;
    },
  };
}

function fakeRedis(): Redis {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      store.delete(key);
      return 1;
    },
    keys: async (pattern: string) => {
      const re = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      return [...store.keys()].filter((k) => re.test(k));
    },
    pttl: async (key: string) => ttls.get(key) ?? -1,
    _setPttl: (key: string, ms: number) => {
      ttls.set(key, ms);
    },
  } as unknown as Redis & { _setPttl(key: string, ms: number): void };
}

function activeKey(session: string) {
  return `rs-active:${session}`;
}

describe("run stale watchdog", () => {
  it("closes a running stream whose owner WAL is stale", async () => {
    const store = fakeStore();
    const redis = fakeRedis();
    await redis.set(activeKey("session-1"), "stream-1");
    await redis.set(RUN_OWNER_WAL_KEY("stream-1"), String(Date.now() - 120_000));

    const released: string[] = [];
    await sweepStaleRuns({
      redis,
      store,
      walStaleMs: 60_000,
      releaseActiveRun: async (_sessionId, streamId) => {
        released.push(streamId);
      },
    });

    expect(store.events).toContain("error");
    expect(store.closed).toEqual([{ status: "error" }]);
    expect(released).toContain("stream-1");
  });

  it("closes a running stream with no WAL after the grace window", async () => {
    const store = fakeStore();
    const redis = fakeRedis();
    await redis.set(activeKey("session-1"), "stream-1");
    await redis.set(RUN_CREATED_KEY("stream-1"), String(Date.now() - 120_000)); // created long ago

    const released: string[] = [];
    await sweepStaleRuns({
      redis,
      store,
      walStaleMs: 60_000,
      walGraceMs: 30_000,
      releaseActiveRun: async (_sessionId, streamId) => {
        released.push(streamId);
      },
    });

    expect(store.closed).toEqual([{ status: "error" }]);
    expect(released).toContain("stream-1");
  });

  it("skips a stream with no WAL inside the grace window", async () => {
    const store = fakeStore();
    const redis = fakeRedis();
    await redis.set(activeKey("session-1"), "stream-1");
    await redis.set(RUN_CREATED_KEY("stream-1"), String(Date.now())); // created just now

    await sweepStaleRuns({
      redis,
      store,
      walStaleMs: 60_000,
      walGraceMs: 30_000,
      releaseActiveRun: async () => undefined,
    });

    expect(store.events).toEqual([]);
    expect(store.closed).toEqual([]);
  });

  it("skips a stream whose WAL is fresh", async () => {
    const store = fakeStore();
    const redis = fakeRedis();
    await redis.set("rs-active:session-1", "stream-1");
    await redis.set(RUN_OWNER_WAL_KEY("stream-1"), String(Date.now()));

    await sweepStaleRuns({
      redis,
      store,
      walStaleMs: 60_000,
      releaseActiveRun: async () => undefined,
    });

    expect(store.events).toEqual([]);
    expect(store.closed).toEqual([]);
  });

  it("skips a stream with no WAL (worker still booting)", async () => {
    const store = fakeStore();
    const redis = fakeRedis();
    await redis.set("rs-active:session-1", "stream-1");

    await sweepStaleRuns({
      redis,
      store,
      walStaleMs: 60_000,
      releaseActiveRun: async () => undefined,
    });

    expect(store.events).toEqual([]);
    expect(store.closed).toEqual([]);
  });

  it("closeStaleRun is a no-op when the stream is no longer running", async () => {
    const store = {
      ...fakeStore(),
      async status() {
        const state: ResumableStreamState = { status: "completed", lastEventId: 5 };
        return state;
      },
    };
    let released = false;
    await closeStaleRun(
      "stream-1",
      "session-1",
      store,
      async () => {
        released = true;
      },
    );
    expect(store.events).toEqual([]);
    expect(store.closed).toEqual([]);
    expect(released).toBe(false);
  });
});