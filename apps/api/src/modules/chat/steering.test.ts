import { describe, expect, it, vi } from "vitest";
import type { AgentStream, AgentStreamEvent } from "@anvia/core/agent";
import {
  createSteeringStore,
  isSteerMessage,
  SteeringPump,
  steerMessageToCoreMessage,
  type SteerMessage,
} from "./steering.js";

type FakeRedis = {
  eval: ReturnType<typeof vi.fn>;
};

function createFakeRedis(): FakeRedis {
  const queue: string[] = [];
  const seen = new Set<string>();
  return {
    eval: vi.fn(async (script: string, _keys: number, ...args: string[]) => {
      if (script.includes("steer-push")) {
        const id = args[2]!;
        if (seen.has(id)) return 0;
        seen.add(id);
        queue.push(args[3]!);
        return 1;
      }
      if (script.includes("steer-requeue")) {
        queue.unshift(args[1]!);
        return 1;
      }
      if (script.includes("steer-pop")) return queue.shift() ?? "";
      if (script.includes("steer-drain")) {
        const count = queue.length;
        queue.length = 0;
        return count;
      }
      return 0;
    }),
  };
}

const sample: SteerMessage = {
  clientMessageId: "msg-1",
  text: "follow up",
};

function fakeStream(steer: (input: unknown) => { id: string; status: "queued" }): AgentStream {
  const events = (async function* (): AsyncGenerator<AgentStreamEvent> {})();
  return {
    events,
    [Symbol.asyncIterator]() { return events[Symbol.asyncIterator](); },
    textStream: (async function* () {})(),
    text: Promise.resolve(""),
    result: Promise.resolve(undefined as never),
    steer,
    cancel: vi.fn(),
  } as AgentStream;
}

describe("createSteeringStore", () => {
  it("uses one atomic Redis operation for idempotent FIFO push", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as never);
    expect(await store.push("stream-1", sample)).toBe(true);
    expect(await store.push("stream-1", sample)).toBe(false);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[0]?.[0]).toContain("steer");
  });

  it("validates queued payloads and keeps FIFO order", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as never);
    await store.push("stream-1", sample);
    await store.push("stream-1", { ...sample, clientMessageId: "msg-2" });
    expect(await store.pop("stream-1")).toEqual(sample);
    expect((await store.pop("stream-1"))?.clientMessageId).toBe("msg-2");
    expect(await store.pop("stream-1")).toBeNull();
  });
});

describe("steerMessageToCoreMessage", () => {
  it("maps the queued message to the native {prompt} input", () => {
    const message = steerMessageToCoreMessage({
      clientMessageId: "msg-1",
      text: "look at this",
    });
    expect(message.role).toBe("user");
    expect(message.metadata).toMatchObject({ clientMessageId: "msg-1", queued: true });
  });
});

describe("isSteerMessage", () => {
  it("accepts only bounded strict queued messages", () => {
    expect(isSteerMessage(sample)).toBe(true);
    expect(isSteerMessage({ ...sample, clientMessageId: "" })).toBe(false);
    expect(isSteerMessage({ ...sample, text: 5 })).toBe(false);
    expect(isSteerMessage({ ...sample, attachments: [{ mediaType: "image/png" }] })).toBe(false);
  });
});

describe("SteeringPump", () => {
  it("acknowledges only a matching native steering_applied receipt", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as never);
    await store.push("stream-1", sample);
    const steered: unknown[] = [];
    const applied: string[] = [];
    const stream = fakeStream((input) => {
      steered.push(input);
      return { id: "receipt-1", status: "queued" };
    });
    const pump = new SteeringPump(
      "stream-1",
      store,
      () => stream,
      async (item) => { applied.push(item.clientMessageId); },
    );
    await pump.afterEvent();
    expect(steered[0]).toMatchObject({ prompt: { role: "user" } });
    await pump.beforeEvent({ type: "turn_start", turn: 1 });
    expect(applied).toEqual([]);
    await pump.beforeEvent({ type: "steering_applied", id: "wrong", turn: 1 });
    expect(applied).toEqual([]);
    await pump.beforeEvent({ type: "steering_applied", id: "receipt-1", turn: 1 });
    expect(applied).toEqual(["msg-1"]);
  });

  it("rearms an unapplied item after retry without popping the next message", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as never);
    await store.push("stream-1", sample);
    await store.push("stream-1", { ...sample, clientMessageId: "msg-2" });
    const steered: string[] = [];
    const stream = fakeStream((input) => {
      const message = input as { prompt?: { metadata?: { clientMessageId?: string } } };
      steered.push(message.prompt?.metadata?.clientMessageId ?? "");
      return { id: `receipt-${steered.length}`, status: "queued" };
    });
    const pump = new SteeringPump("stream-1", store, () => stream, async () => {});
    await pump.afterEvent();
    pump.rearmSteer();
    await pump.afterEvent();
    expect(steered).toEqual(["msg-1", "msg-1"]);
    await pump.beforeEvent({ type: "steering_applied", id: "receipt-2", turn: 1 });
    await pump.afterEvent();
    expect(steered).toEqual(["msg-1", "msg-1", "msg-2"]);
  });

  it("requeues an unapplied item on terminal cleanup and rejects new submissions after close", async () => {
    const redis = createFakeRedis();
    const store = createSteeringStore(redis as never);
    await store.push("stream-1", sample);
    const stream = fakeStream(() => ({ id: "receipt-1", status: "queued" }));
    const pump = new SteeringPump("stream-1", store, () => stream, async () => {});
    await pump.afterEvent();
    await pump.close({ requeueUnapplied: true });
    expect(await store.pop("stream-1")).toEqual(sample);
    await pump.afterEvent();
    expect(await store.pop("stream-1")).toBeNull();
  });
});
