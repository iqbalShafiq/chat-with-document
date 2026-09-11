import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { CLIENT_STREAM_PROTOCOL } from "@anvia/client";
import { resumeClientStreamResponse, type ClientResumableEvent } from "@anvia/server";
import { createRedisResumableStreamStore } from "./resumable-stream-store.js";

type Entry = [string, string[]];

function createFakeRedis(atomicOnly = false) {
  const hashes = new Map<string, Record<string, string>>();
  const strings = new Map<string, string>();
  const streams = new Map<string, Entry[]>();
  const ttls = new Map<string, number>();
  const waiters = new Set<() => void>();
  const notify = () => { for (const wake of waiters) wake(); waiters.clear(); };
  const fake = {
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    hgetall: vi.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) })),
    hset: vi.fn(async (key: string, fieldOrFields: string | Record<string, unknown>, value?: unknown) => {
      const hash = hashes.get(key) ?? {};
      if (typeof fieldOrFields === "string") hash[fieldOrFields] = String(value);
      else for (const [field, fieldValue] of Object.entries(fieldOrFields)) hash[field] = String(fieldValue);
      hashes.set(key, hash);
      return 1;
    }),
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { strings.set(key, value); return "OK"; }),
    incr: vi.fn(async (key: string) => { const value = Number(strings.get(key) ?? 0) + 1; strings.set(key, String(value)); return value; }),
    del: vi.fn(async (...keys: string[]) => { for (const key of keys) { hashes.delete(key); strings.delete(key); streams.delete(key); } return keys.length; }),
    expire: vi.fn(async (key: string, seconds: number) => {
      if (atomicOnly) throw new Error("TTL must be changed inside Redis transition");
      ttls.set(key, seconds);
      return 1;
    }),
    xrange: vi.fn(async (key: string, start: string, _end: string, _countWord?: string, count?: number) => {
      const after = Number(start.startsWith("(") ? start.slice(1).split("-")[0] : start.split("-")[0]);
      return (streams.get(key) ?? []).filter(([id]) => Number(id.split("-")[0]) > after).slice(0, count ?? 128);
    }),
    xread: vi.fn(async (..._args: unknown[]) => new Promise((resolve) => {
      const wake = () => resolve([]);
      waiters.add(wake);
      setTimeout(wake, 5);
    })),
    eval: vi.fn(async (script: string, _numKeys: number, ...args: string[]) => {
      const [statusKey, eventsKey, counterKey] = args;
      const payload = args[3];
      const finalStatus = args[3];
      const hash = hashes.get(statusKey) ?? {};
      if (script.includes("ownerMatches")) {
        const [userId, sessionId, modelId, reasoningEffort] = args.slice(3, 7);
        if (hash.status && (!hash.userId || hash.userId !== userId)) return [-1, "owner-mismatch"];
        if (hash.status && (!hash.sessionId || hash.sessionId !== sessionId)) return [-1, "owner-mismatch"];
        if (hash.status && (!hash.modelId || hash.modelId !== modelId)) return [-1, "owner-mismatch"];
        if (hash.status && (hash.reasoningEffort === undefined || hash.reasoningEffort !== reasoningEffort)) return [-1, "owner-mismatch"];
        if (!hash.status) {
          hash.status = "running";
          hash.userId = userId;
          hash.sessionId = sessionId;
          hash.modelId = modelId;
          hash.reasoningEffort = reasoningEffort;
          hashes.set(statusKey, hash);
          streams.set(eventsKey, []);
          strings.delete(counterKey);
          ttls.set(statusKey, 6 * 60 * 60);
          ttls.set(eventsKey, 6 * 60 * 60);
          ttls.set(counterKey, 6 * 60 * 60);
          return [1, "running"];
        }
        if (hash.status === "running") {
          hash.userId = userId;
          hash.sessionId = sessionId;
          hash.modelId = modelId;
          hash.reasoningEffort = reasoningEffort;
          hashes.set(statusKey, hash);
          ttls.set(statusKey, 6 * 60 * 60);
          ttls.set(eventsKey, 6 * 60 * 60);
          ttls.set(counterKey, 6 * 60 * 60);
        } else {
          ttls.set(statusKey, 24 * 60 * 60);
          ttls.set(eventsKey, 24 * 60 * 60);
          ttls.set(counterKey, 24 * 60 * 60);
        }
        return [0, hash.status];
      }
      if (script.includes("local eventId = redis.call('INCR'")) {
        if (hash.status !== "running") return [0, hash.status ?? ""];
        const eventId = Number(strings.get(counterKey) ?? 0) + 1;
        strings.set(counterKey, String(eventId));
        const id = `${eventId}-0`;
        const entries = streams.get(eventsKey) ?? [];
        entries.push([id, ["e", payload ?? ""]]);
        streams.set(eventsKey, entries);
        ttls.set(statusKey, 6 * 60 * 60);
        ttls.set(eventsKey, 6 * 60 * 60);
        ttls.set(counterKey, 6 * 60 * 60);
        notify();
        return [eventId, id];
      }
      if (script.includes("__end__")) {
        if (!hash.status) return [0, "missing", 0];
        if (hash.status !== "running") {
          if (hash.status === finalStatus) {
            ttls.set(statusKey, 24 * 60 * 60);
            ttls.set(eventsKey, 24 * 60 * 60);
            ttls.set(counterKey, 24 * 60 * 60);
            return [0, hash.status, Number(strings.get(counterKey) ?? 0)];
          }
          return [-1, hash.status, Number(strings.get(counterKey) ?? 0)];
        }
        hash.status = finalStatus ?? "error";
        hashes.set(statusKey, hash);
        const next = Number(strings.get(counterKey) ?? 0) + 1;
        const entries = streams.get(eventsKey) ?? [];
        entries.push([`${next}-0`, ["e", JSON.stringify({ __end__: finalStatus })]]);
        streams.set(eventsKey, entries);
        ttls.set(statusKey, 24 * 60 * 60);
        ttls.set(eventsKey, 24 * 60 * 60);
        ttls.set(counterKey, 24 * 60 * 60);
        notify();
        return [1, finalStatus, Number(strings.get(counterKey) ?? 0)];
      }
      if (!hash.status) {
        hash.status = "running";
        hashes.set(statusKey, hash);
        streams.set(eventsKey, []);
        strings.delete(counterKey);
        ttls.set(statusKey, 6 * 60 * 60);
        ttls.set(eventsKey, 6 * 60 * 60);
        ttls.set(counterKey, 6 * 60 * 60);
        return [1, "running"];
      }
      ttls.set(statusKey, 6 * 60 * 60);
      ttls.set(eventsKey, 6 * 60 * 60);
      ttls.set(counterKey, 6 * 60 * 60);
      return [0, hash.status];
    }),
    _ttls: ttls,
    _streams: streams,
    _hashes: hashes,
    _atomicOnly: atomicOnly,
  };
  return fake as unknown as Redis & typeof fake;
}

function event(runId = "run-1") {
  return { protocol: CLIENT_STREAM_PROTOCOL, event: { runId, type: "run_start", source: "agent" } } as const;
}

describe("Redis resumable stream store", () => {
  it("opens idempotently and applies lifecycle TTLs to every owned key", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    expect(await store.open({ streamId: "s1" })).toEqual({ status: "running", lastEventId: 0 });
    await store.append({ streamId: "s1", event: event() });
    expect(await store.open({ streamId: "s1" })).toEqual({ status: "running", lastEventId: 1 });
    expect(redis._ttls.get("rs:{s1}")).toBe(6 * 60 * 60);
    expect(redis._ttls.get("rs:{s1}:events")).toBe(6 * 60 * 60);
    expect(redis._ttls.get("rs:{s1}:counter")).toBe(6 * 60 * 60);
  });

  it("rejects untagged and legacy records before Redis mutation", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    await expect(store.append({ streamId: "s1", event: { type: "text_delta" } as never })).rejects.toThrow();
    await expect(store.append({ streamId: "s1", event: { protocol: "anvia.client.v1", event: {} } as never })).rejects.toThrow();
    expect(redis.eval).not.toHaveBeenCalledWith(expect.stringContaining("local eventId = redis.call('INCR'"), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("assigns contiguous ids, hides the terminal sentinel, and resumes after a cursor", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    await store.append({ streamId: "s1", event: event() });
    await store.append({ streamId: "s1", event: event("run-2") });
    expect((await store.status({ streamId: "s1" })).lastEventId).toBe(2);
    await store.close({ streamId: "s1", status: "completed" });
    const records = [];
    for await (const record of store.subscribe({ streamId: "s1", after: 1 })) records.push(record);
    expect(records.map((record) => record.eventId)).toEqual([2]);
    expect(records.some((record) => JSON.stringify(record.event).includes("__end__"))).toBe(false);
    expect(await store.status({ streamId: "s1" })).toEqual({ status: "completed", lastEventId: 2 });
    expect(redis._ttls.get("rs:{s1}")).toBe(24 * 60 * 60);
    expect(redis._ttls.get("rs:{s1}:events")).toBe(24 * 60 * 60);
    expect(redis._ttls.get("rs:{s1}:counter")).toBe(24 * 60 * 60);
  });

  it("does not append after terminal close and rejects conflicting close", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    await store.close({ streamId: "s1", status: "error" });
    await expect(store.append({ streamId: "s1", event: event() })).rejects.toThrow();
    await expect(store.close({ streamId: "s1", status: "completed" })).rejects.toThrow();
    expect(await store.close({ streamId: "s1", status: "error" })).toEqual({ status: "error", lastEventId: 0 });
  });

  it("changes all lifecycle TTLs inside atomic Redis transitions", async () => {
    const redis = createFakeRedis(true);
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    await store.append({ streamId: "s1", event: event() });
    await store.close({ streamId: "s1", status: "completed" });
    expect(redis._ttls).toEqual(new Map([
      ["rs:{s1}", 24 * 60 * 60],
      ["rs:{s1}:events", 24 * 60 * 60],
      ["rs:{s1}:counter", 24 * 60 * 60],
    ]));
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("repairs every terminal TTL on an idempotent close", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    await store.append({ streamId: "s1", event: event() });
    await store.close({ streamId: "s1", status: "completed" });
    redis._ttls.set("rs:{s1}", 1);
    redis._ttls.set("rs:{s1}:events", 1);
    redis._ttls.set("rs:{s1}:counter", 1);
    await store.close({ streamId: "s1", status: "completed" });
    expect(redis._ttls.get("rs:{s1}")).toBe(24 * 60 * 60);
    expect(redis._ttls.get("rs:{s1}:events")).toBe(24 * 60 * 60);
    expect(redis._ttls.get("rs:{s1}:counter")).toBe(24 * 60 * 60);
  });

  it("initializes ownership atomically and rejects a running owner mismatch", async () => {
    const redis = createFakeRedis(true);
    const store = createRedisResumableStreamStore(redis);
    const meta = { userId: "u1", sessionId: "session-1", modelId: "model-1", reasoningEffort: "max" };
    await store.openWithMeta({ streamId: "s1" }, meta);
    expect(await store.getMeta("s1")).toEqual(meta);
    await store.openWithMeta({ streamId: "s1" }, meta);
    await expect(store.openWithMeta({ streamId: "s1" }, { ...meta, userId: "u2" })).rejects.toThrow(/owner|metadata|mismatch/i);
    expect(await store.getMeta("s1")).toEqual(meta);
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("fails closed when an existing stream has missing owner metadata", async () => {
    const redis = createFakeRedis(true);
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    const meta = { userId: "u1", sessionId: "session-1", modelId: "model-1", reasoningEffort: "max" };
    await expect(store.openWithMeta({ streamId: "s1" }, meta)).rejects.toThrow(/owner|metadata|mismatch/i);
  });

  it("returns the parsed stored envelope rather than the caller object", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    const input = event();
    const record = await store.append({ streamId: "s1", event: input });
    (input.event as { runId: string }).runId = "mutated";
    expect((record.event as ClientResumableEvent).event.runId).toBe("run-1");
  });

  it("rejects a corrupt nested private field when replaying a Redis row", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    redis._streams.set("rs:{s1}:events", [["1-0", ["e", JSON.stringify({
      protocol: CLIENT_STREAM_PROTOCOL,
      event: {
        runId: "run-1",
        type: "data",
        name: "deepResearchProgress",
        data: {
          phase: "researching",
          message: "safe",
          activities: [{ id: "a", kind: "retrieval", label: "x", status: "active", prompt: "secret" }],
          stats: { retrievalCalls: 1, retrievalLimit: 2, reasoning: "secret" },
        },
      },
    })]]]);
    await expect(store.subscribe({ streamId: "s1" })[Symbol.asyncIterator]().next()).rejects.toThrow();
  });

  it("persists tool wait progress data events through the store envelope", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    const event = {
      protocol: CLIENT_STREAM_PROTOCOL,
      event: {
        runId: "run-1",
        type: "data",
        name: "toolWaitProgress",
        data: {
          toolCallId: "tool_0",
          toolName: "generate_image",
          phase: "wait_elapsed",
          elapsedMs: 2002,
          waitCount: 1,
        },
      },
    } as never;
    const record = await store.append({ streamId: "s1", event });
    expect(record.eventId).toBe(1);
    const bad = {
      ...event,
      event: { ...(event as { event: Record<string, unknown> }).event, data: { leaked: true } },
    } as never;
    await expect(store.append({ streamId: "s1", event: bad })).rejects.toThrow(/Invalid protocol-v3/);
  });

  it("maps a malformed replay to an error stream_end through the official response guard", async () => {
    const fakeStore = {
      async open() { return { status: "running" as const, lastEventId: 0 }; },
      async append() { throw new Error("unused"); },
      async *subscribe() { yield { streamId: "s1", eventId: 1, event: { protocol: "anvia.client.v1", event: {} } as never }; },
      async status() { return { status: "completed" as const, lastEventId: 1 }; },
      async close() { return { status: "completed" as const, lastEventId: 1 }; },
    };
    const response = resumeClientStreamResponse({ streamId: "s1", after: 0, store: fakeStore });
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ type: "stream_end", status: "error" });
    expect(lines.some((line) => line.type === "stream_event")).toBe(false);
  });

  it("keeps concurrent appends contiguous and paired with their own payloads", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) => store.append({ streamId: "s1", event: event(`run-${index}`) })));
    expect(records.map((record) => record.eventId).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect((await store.status({ streamId: "s1" })).lastEventId).toBe(20);
    const stored = redis._streams.get("rs:{s1}:events") ?? [];
    expect(stored).toHaveLength(20);
    expect(new Set(stored.map(([id]) => id.split("-")[0])).size).toBe(20);
  });

  it("serializes an append/close race with no post-terminal append or duplicate wake marker", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    await Promise.allSettled([
      store.append({ streamId: "s1", event: event("race") }),
      store.close({ streamId: "s1", status: "completed" }),
    ]);
    expect((await store.status({ streamId: "s1" })).status).toBe("completed");
    const rows = redis._streams.get("rs:{s1}:events") ?? [];
    expect(rows.filter(([, fields]) => fields[1]?.includes("__end__"))).toHaveLength(1);
    expect((await store.subscribe({ streamId: "s1" }))[Symbol.asyncIterator]()).toBeDefined();
  });

  it("wakes a blocked subscriber, drains the final event, and completes without the sentinel", async () => {
    const redis = createFakeRedis();
    const store = createRedisResumableStreamStore(redis);
    await store.open({ streamId: "s1" });
    const iterator = store.subscribe({ streamId: "s1" })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await store.append({ streamId: "s1", event: event() });
    expect((await pending)).toMatchObject({ done: false, value: { eventId: 1 } });
    await store.close({ streamId: "s1", status: "completed" });
    expect(await iterator.next()).toMatchObject({ done: true });
  });
});
