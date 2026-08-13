import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  createSteeringStore,
  isSteerMessage,
  SteeringPump,
  steerMessageToCoreMessage,
  type SteerMessage,
} from "./steering.js";

type FakeRedis = Pick<
  Redis,
  "sadd" | "expire" | "rpush" | "lpop" | "llen" | "del"
>;

function createFakeRedis(): FakeRedis & {
  lists: Map<string, string[]>;
  sets: Map<string, Set<string>>;
  ttlKeys: Set<string>;
} {
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const ttlKeys = new Set<string>();
  const fake = {
    lists,
    sets,
    ttlKeys,
    async sadd(key: string, member: unknown) {
      const set = sets.get(key) ?? new Set<string>();
      const had = set.has(String(member));
      set.add(String(member));
      sets.set(key, set);
      return had ? 0 : 1;
    },
    async expire(key: string) {
      ttlKeys.add(key);
      return 1;
    },
    async rpush(key: string, value: unknown) {
      const list = lists.get(key) ?? [];
      list.push(String(value));
      lists.set(key, list);
      return list.length;
    },
    async lpop(key: string) {
      const list = lists.get(key) ?? [];
      return list.shift() ?? null;
    },
    async llen(key: string) {
      return (lists.get(key) ?? []).length;
    },
    async del(key: string) {
      lists.delete(key);
      return 1;
    },
  } as unknown as FakeRedis & ReturnType<typeof createFakeRedis>;
  return fake;
}

const sample: SteerMessage = {
  clientMessageId: "msg-1",
  text: "follow up",
};

describe("createSteeringStore", () => {
  it("pushes a message into the per-stream list with a TTL", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as unknown as Redis);
    const ok = await store.push("stream-1", sample);
    expect(ok).toBe(true);
    expect(redis.lists.get("rs-steer:stream-1")).toEqual([JSON.stringify(sample)]);
    expect(redis.ttlKeys.has("rs-steer:stream-1")).toBe(true);
    expect(redis.ttlKeys.has("rs-steer-sent:stream-1")).toBe(true);
  });

  it("is idempotent per stream (same clientMessageId pushes once)", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as unknown as Redis);
    expect(await store.push("stream-1", sample)).toBe(true);
    expect(await store.push("stream-1", { ...sample, text: "edited" })).toBe(false);
    expect(redis.lists.get("rs-steer:stream-1")).toHaveLength(1);
  });

  it("pops messages FIFO and drops malformed JSON", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as unknown as Redis);
    await store.push("stream-1", sample);
    await store.push("stream-1", { ...sample, clientMessageId: "msg-2" });
    redis.lists.get("rs-steer:stream-1")!.push("{not json");
    expect(await store.pop("stream-1")).toEqual(sample);
    expect((await store.pop("stream-1"))?.clientMessageId).toBe("msg-2");
    expect(await store.pop("stream-1")).toBeNull();
  });

  it("drain returns the discarded count and deletes the list", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as unknown as Redis);
    await store.push("stream-1", sample);
    await store.push("stream-1", { ...sample, clientMessageId: "msg-2" });
    expect(await store.drain("stream-1")).toBe(2);
    expect(redis.lists.has("rs-steer:stream-1")).toBe(false);
    expect(await store.drain("stream-1")).toBe(0);
  });
});

describe("steerMessageToCoreMessage", () => {
  it("maps text, image attachments, and metadata", () => {
    const message = steerMessageToCoreMessage({
      clientMessageId: "msg-1",
      text: "look at this",
      attachments: [
        { mediaType: "image/png", data: "data:image/png;base64,AAAA" },
      ],
    });
    expect(message.role).toBe("user");
    const content = message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", data: "AAAA", mediaType: "image/png" },
    });
    expect(content[1]).toEqual({ type: "text", text: "look at this" });
    expect(message.metadata).toMatchObject({
      clientMessageId: "msg-1",
      queued: true,
    });
  });

  it("prepends the context snippet as a text block before the text", () => {
    const message = steerMessageToCoreMessage({
      clientMessageId: "msg-1",
      text: "continue",
      contextSnippet: { text: "pinned note", sourceRole: "user" },
    });
    const content = message.content as Array<{ type: string; text?: string }>;
    const texts = content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("pinned note");
    expect(texts[1]).toBe("continue");
  });

  it("keeps an empty text part when there are no attachments", () => {
    const message = steerMessageToCoreMessage({
      clientMessageId: "msg-1",
      text: "",
    });
    expect((message.content as unknown[]).length).toBe(1);
  });
});

describe("isSteerMessage", () => {
  it("accepts a valid message and rejects malformed shapes", () => {
    expect(isSteerMessage(sample)).toBe(true);
    expect(isSteerMessage({ ...sample, clientMessageId: 5 })).toBe(false);
    expect(isSteerMessage({ ...sample, text: undefined })).toBe(false);
    expect(
      isSteerMessage({ ...sample, attachments: [{ mediaType: "image/png" }] }),
    ).toBe(false);
    expect(
      isSteerMessage({
        ...sample,
        contextSnippet: { text: "x", sourceRole: "system" },
      }),
    ).toBe(false);
  });
});

describe("SteeringPump", () => {
  function createHarness() {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as unknown as Redis);
    const steered: string[] = [];
    const applied: SteerMessage[] = [];
    const target = {
      steer(input: unknown): boolean {
        const message = input as { metadata?: Record<string, unknown> };
        steered.push(String(message.metadata?.clientMessageId));
        return true;
      },
      stream(): AsyncIterable<unknown> {
        return (async function* () {})();
      },
    };
    const pump = new SteeringPump(
      "stream-1",
      store,
      () => target,
      async (item) => {
        applied.push(item);
      },
    );
    return { store, pump, target, steered, applied };
  }

  const turnStart = (turn: number) => ({ type: "turn_start", turn });
  const textDelta = (turn: number) => ({ type: "text_delta", turn, delta: "x" });

  it("steers one message per turn and acks at the next turn_start", async () => {
    const h = createHarness();
    await h.store.push("stream-1", sample);
    await h.store.push("stream-1", { ...sample, clientMessageId: "msg-2" });

    await h.pump.beforeEvent(turnStart(0));
    await h.pump.afterEvent(); // pops msg-1 during turn 0
    expect(h.steered).toEqual(["msg-1"]);

    await h.pump.beforeEvent(textDelta(0));
    await h.pump.afterEvent(); // active steer holds the queue
    expect(h.steered).toEqual(["msg-1"]);
    expect(h.applied).toEqual([]);

    await h.pump.beforeEvent(turnStart(1)); // steered turn begins -> ack msg-1
    await h.pump.afterEvent(); // pops msg-2 for the next turn
    expect(h.applied.map((item) => item.clientMessageId)).toEqual(["msg-1"]);
    expect(h.steered).toEqual(["msg-1", "msg-2"]);

    await h.pump.beforeEvent(turnStart(2)); // ack msg-2
    expect(h.applied.map((item) => item.clientMessageId)).toEqual([
      "msg-1",
      "msg-2",
    ]);
  });

  it("does not ack at the same turn the steer happened", async () => {
    const h = createHarness();
    await h.store.push("stream-1", sample);
    await h.pump.beforeEvent(turnStart(0));
    await h.pump.afterEvent();
    await h.pump.beforeEvent(turnStart(0)); // duplicate no-op guard
    expect(h.applied).toEqual([]);
    await h.pump.beforeEvent(turnStart(1));
    expect(h.applied.map((item) => item.clientMessageId)).toEqual(["msg-1"]);
  });

  it("drops the message when steer() returns false (run terminal)", async () => {
    const h = createHarness();
    h.target.steer = () => false;
    await h.store.push("stream-1", sample);
    await h.pump.beforeEvent(turnStart(0));
    await h.pump.afterEvent();
    await h.pump.beforeEvent(turnStart(1));
    await h.pump.beforeEvent(turnStart(2));
    expect(h.applied).toEqual([]);
  });

  it("re-injects the pending steer into a new target after rearmSteer()", async () => {
    const h = createHarness();
    await h.store.push("stream-1", sample);
    await h.pump.beforeEvent(turnStart(0));
    await h.pump.afterEvent(); // steer msg-1 into target A
    expect(h.steered).toEqual(["msg-1"]);

    h.pump.rearmSteer(); // transient retry: new request instance
    await h.pump.beforeEvent(turnStart(0)); // new run turn 0 = original prompt
    await h.pump.afterEvent(); // re-steers into the new target
    expect(h.steered).toEqual(["msg-1", "msg-1"]);

    await h.pump.beforeEvent(turnStart(1)); // steered turn of the new run
    expect(h.applied.map((item) => item.clientMessageId)).toEqual(["msg-1"]);
  });

  it("drain clears the active steer and discards the remaining list", async () => {
    const h = createHarness();
    await h.store.push("stream-1", sample);
    await h.pump.beforeEvent(turnStart(0));
    await h.pump.afterEvent();
    expect(await h.pump.drain()).toBe(0); // popped already
    await h.store.push("stream-1", { ...sample, clientMessageId: "msg-2" });
    expect(await h.pump.drain()).toBe(1);
    await h.pump.beforeEvent(turnStart(1));
    expect(h.applied).toEqual([]);
  });
});
