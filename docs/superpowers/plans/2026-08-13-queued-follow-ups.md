# Queued Follow-Ups (Send While Streaming) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users queue full composer drafts while the agent is streaming, flush them one-per-turn into the active run via `PromptRequest.steer()` (or as new runs after completion), with edit/reorder/persistence and hold semantics.

**Architecture:** Client owns the queue (localStorage per session). `POST /api/chat/steer` pushes messages into a per-stream Redis list; the chat-run worker drains it one message per turn through `PromptRequest.steer()` (SDK `@anvia/core` 0.25.1 steering at safe model-turn boundaries) and acks each applied message with a `queued_message_applied` stream event. `POST /api/chat/queue/sync` dedupes queue items already applied to memory across reloads. Auto-flush after normal completion reuses the existing send pipeline; Stop/error hold the queue.

**Tech Stack:** Hono (api), BullMQ worker, ioredis, @anvia/core 0.25.1 (steer), React 19 + @anvia/react 0.9.3 + @anvia/react-ui 0.6.2 (platform), Tailwind CSS 4, Vitest, Playwright (stub LLM on :18765).

## Global Constraints

- Branch: `feat/queued-follow-ups` (from origin/main). Commit style: `feat(api): ...` / `feat(platform): ...` / `fix(platform): ...` (matches repo history).
- No new npm dependencies. Drag & drop uses native HTML5 events.
- Spec: `docs/superpowers/specs/2026-08-13-queued-follow-ups-design.md` is the source of truth.
- Server types come from `@anvia/core/completion` (`Message`, `UserContent`); the PromptRequest handle in the worker is a narrow structural interface (`SteerableRequest`) because `PromptRequest` is not exported from the package root.
- Redis keys: steer list `rs-steer:<streamId>`, idempotency set `rs-steer-sent:<streamId>` (both TTL 24h, refreshed per write).
- localStorage key per session: `chat.queue.<sessionId>`.
- Existing behavior must not regress: manual send, approvals, clarifications, compaction, image generation, e2e suite (`apps/platform/e2e/image-generation.e2e.ts`).
- Queue items snapshot at queue time: text + image attachments (serialized data) + uploaded documentIds + context snippet + pinned image ids. Session toggles (web search, image gen, model) are read live at execution.
- Flush semantics: FIFO, one per turn; `editing` items block the flush at their position; hold after Stop/error (in-memory only, not persisted).

---

### Task 1: Server steering module (store + builder + pump)

**Files:**
- Create: `apps/api/src/modules/chat/steering.ts`
- Test: `apps/api/src/modules/chat/steering.test.ts`

**Interfaces:**
- Consumes: `getRedis()` from `../../lib/redis.js`; `Message`, `UserContent` from `@anvia/core/completion`.
- Produces (used by Tasks 2–5): `SteerMessage`, `SteerContextSnippet`, `SteerAttachment`, `isSteerMessage`, `steerMessageToCoreMessage`, `createSteeringStore(redis)`, `SteeringStore`, `getSteeringStore()`, `SteerableRequest`, `SteeringPump`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/chat/steering.test.ts`:

```ts
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
  } as FakeRedis & ReturnType<typeof createFakeRedis>;
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
    expect(await store.pop("stream-1")?.clientMessageId).toBe("msg-2");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api exec vitest run src/modules/chat/steering.test.ts`
Expected: FAIL — cannot find module `./steering.js`.

- [ ] **Step 3: Implement the module**

Create `apps/api/src/modules/chat/steering.ts`:

```ts
import type { Redis } from "ioredis";
import {
  Message,
  UserContent,
  type Message as MessageType,
} from "@anvia/core/completion";
import { getRedis } from "../../lib/redis.js";

export type SteerContextSnippet = {
  text: string;
  sourceRole: "user" | "assistant";
};

export type SteerAttachment = {
  mediaType: string;
  data: string; // base64 or data URL
};

export type SteerMessage = {
  clientMessageId: string;
  text: string;
  attachments?: SteerAttachment[];
  contextSnippet?: SteerContextSnippet | null;
};

const STEER_KEY = (streamId: string) => `rs-steer:${streamId}`;
const STEER_SENT_KEY = (streamId: string) => `rs-steer-sent:${streamId}`;
const STEER_TTL_SECONDS = 24 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64FromData(value: string): string {
  const match = /^data:[^;]*;base64,(.+)$/s.exec(value);
  return match ? match[1] : value;
}

export function isSteerMessage(value: unknown): value is SteerMessage {
  if (!isRecord(value)) return false;
  if (
    typeof value.clientMessageId !== "string" ||
    value.clientMessageId.length === 0
  ) {
    return false;
  }
  if (typeof value.text !== "string") return false;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) return false;
    for (const attachment of value.attachments) {
      if (
        !isRecord(attachment) ||
        typeof attachment.mediaType !== "string" ||
        typeof attachment.data !== "string"
      ) {
        return false;
      }
    }
  }
  if (value.contextSnippet !== undefined && value.contextSnippet !== null) {
    if (
      !isRecord(value.contextSnippet) ||
      typeof value.contextSnippet.text !== "string" ||
      (value.contextSnippet.sourceRole !== "user" &&
        value.contextSnippet.sourceRole !== "assistant")
    ) {
      return false;
    }
  }
  return true;
}

/** Builds the user Message the SDK steer() accepts (images inline, snippet prepended). */
export function steerMessageToCoreMessage(input: SteerMessage): MessageType {
  const parts: ReturnType<typeof UserContent.text>[] = [];
  for (const attachment of input.attachments ?? []) {
    parts.push(
      UserContent.imageBase64(
        base64FromData(attachment.data),
        attachment.mediaType,
        { detail: "auto" },
      ),
    );
  }
  if (input.contextSnippet && input.contextSnippet.text.trim().length > 0) {
    const source =
      input.contextSnippet.sourceRole === "user"
        ? "User-selected text from an earlier user message"
        : "Text selected from an earlier assistant message";
    parts.push(
      UserContent.text(
        `Additional context\n${source}:\n${input.contextSnippet.text}\n`,
      ),
    );
  }
  if (input.text.trim().length > 0 || parts.length === 0) {
    parts.push(UserContent.text(input.text));
  }
  return Message.user(parts, {
    metadata: {
      clientMessageId: input.clientMessageId,
      queued: true,
      createdAt: new Date().toISOString(),
    },
  });
}

export function createSteeringStore(redis: Redis) {
  return {
    steerKey: STEER_KEY,
    /**
     * Idempotent per stream: a clientMessageId already pushed to this stream
     * (double click / reload while the run is still active) is skipped.
     */
    async push(streamId: string, message: SteerMessage): Promise<boolean> {
      const added = await redis.sadd(
        STEER_SENT_KEY(streamId),
        message.clientMessageId,
      );
      if (added === 0) return false;
      await redis.expire(STEER_SENT_KEY(streamId), STEER_TTL_SECONDS);
      await redis.rpush(STEER_KEY(streamId), JSON.stringify(message));
      await redis.expire(STEER_KEY(streamId), STEER_TTL_SECONDS);
      return true;
    },
    async pop(streamId: string): Promise<SteerMessage | null> {
      const raw = await redis.lpop(STEER_KEY(streamId));
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isSteerMessage(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    /** Drops the remaining list; the client still owns those messages. */
    async drain(streamId: string): Promise<number> {
      const count = await redis.llen(STEER_KEY(streamId));
      if (count > 0) {
        await redis.del(STEER_KEY(streamId));
      }
      return count;
    },
  };
}

export type SteeringStore = ReturnType<typeof createSteeringStore>;

let steeringStore: SteeringStore | null = null;

/** Process-wide singleton shared by the chat router and run worker. */
export function getSteeringStore(): SteeringStore {
  if (!steeringStore) {
    steeringStore = createSteeringStore(getRedis());
  }
  return steeringStore;
}

/**
 * Narrow structural view of the SDK's PromptRequest (the class is not
 * exported from the package root). The concrete request satisfies it.
 */
export type SteerableRequest = {
  steer(input: MessageType): boolean;
  stream(): AsyncIterable<unknown>;
};

function isTurnStartEvent(
  event: unknown,
): event is { type: "turn_start"; turn?: unknown } {
  return isRecord(event) && event.type === "turn_start";
}

/**
 * Serializes steering: pops at most one queued message per model turn,
 * acks it (`onApplied`) exactly when the steered turn starts (first
 * turn_start after the steer), and re-injects after a transient retry.
 */
export class SteeringPump {
  private activeSteer: SteerMessage | null = null;
  private steeredAfterTurn = 0;
  private lastTurn = 0;
  private rearmPending = false;

  constructor(
    private readonly streamId: string,
    private readonly steering: SteeringStore,
    private readonly getTarget: () => SteerableRequest | null,
    private readonly onApplied: (applied: SteerMessage) => Promise<void>,
  ) {}

  /** Call when the transient-retry wrapper rebuilds the request. */
  rearmSteer(): void {
    this.rearmPending = true;
  }

  /** Call BEFORE appending an agent stream event to the stream store. */
  async beforeEvent(event: unknown): Promise<void> {
    if (isTurnStartEvent(event) && typeof event.turn === "number") {
      this.lastTurn = event.turn;
    }
    if (
      this.activeSteer !== null &&
      isTurnStartEvent(event) &&
      typeof event.turn === "number" &&
      event.turn > this.steeredAfterTurn
    ) {
      const applied = this.activeSteer;
      this.activeSteer = null;
      await this.onApplied(applied);
    }
  }

  /** Call AFTER appending an agent stream event to the stream store. */
  async afterEvent(): Promise<void> {
    if (this.rearmPending) {
      this.rearmPending = false;
      if (this.activeSteer !== null) {
        const target = this.getTarget();
        if (target !== null) {
          target.steer(steerMessageToCoreMessage(this.activeSteer));
        }
      }
      return;
    }
    if (this.activeSteer !== null) return;
    const item = await this.steering.pop(this.streamId);
    if (item === null) return;
    const target = this.getTarget();
    if (target === null || !target.steer(steerMessageToCoreMessage(item))) {
      console.warn("[chat-run] steer rejected (run terminal)", {
        streamId: this.streamId,
        clientMessageId: item.clientMessageId,
      });
      return;
    }
    this.activeSteer = item;
    this.steeredAfterTurn = this.lastTurn;
  }

  /** Discard leftover list entries (client re-sends after stream end). */
  async drain(): Promise<number> {
    this.activeSteer = null;
    return this.steering.drain(this.streamId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/modules/chat/steering.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat/steering.ts apps/api/src/modules/chat/steering.test.ts
git commit -m "feat(api): steering store and per-turn pump for queued follow-ups"
```

---

### Task 2: Steer request body parser

**Files:**
- Create: `apps/api/src/modules/chat/steer-body.ts`
- Test: `apps/api/src/modules/chat/steer-body.test.ts`

**Interfaces:**
- Consumes: `SteerMessage` from `./steering.js` (Task 1).
- Produces: `parseSteerBody(value: unknown): ParsedSteerBody | null`, `ParsedSteerBody = { sessionId: string; messages: SteerMessage[] }`, `MAX_STEER_MESSAGES`, `MAX_STEER_TEXT_CHARS`, `MAX_STEER_ATTACHMENTS`, `MAX_STEER_ATTACHMENT_BYTES`, `MAX_STEER_CLIENT_ID_CHARS`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/chat/steer-body.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_STEER_MESSAGES,
  MAX_STEER_TEXT_CHARS,
  parseSteerBody,
} from "./steer-body.js";

const validBody = {
  sessionId: "session-1",
  messages: [
    { clientMessageId: "msg-1", text: "follow up" },
    {
      clientMessageId: "msg-2",
      text: "with image",
      attachments: [{ mediaType: "image/png", data: "AAAA" }],
      contextSnippet: { text: "pinned", sourceRole: "user" },
    },
  ],
};

describe("parseSteerBody", () => {
  it("accepts a valid body", () => {
    expect(parseSteerBody(validBody)).toEqual(validBody);
  });

  it("rejects missing or empty sessionId", () => {
    expect(parseSteerBody({ ...validBody, sessionId: "" })).toBeNull();
    expect(parseSteerBody({ messages: validBody.messages })).toBeNull();
  });

  it("rejects empty messages and more than the cap", () => {
    expect(parseSteerBody({ ...validBody, messages: [] })).toBeNull();
    expect(
      parseSteerBody({
        ...validBody,
        messages: Array.from({ length: MAX_STEER_MESSAGES + 1 }, (_, i) => ({
          clientMessageId: `m-${i}`,
          text: "x",
        })),
      }),
    ).toBeNull();
  });

  it("rejects invalid clientMessageId and oversized text", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [{ clientMessageId: "", text: "x" }],
      }),
    ).toBeNull();
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          { clientMessageId: "m", text: "x".repeat(MAX_STEER_TEXT_CHARS + 1) },
        ],
      }),
    ).toBeNull();
  });

  it("rejects empty text without attachments", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [{ clientMessageId: "m", text: "   " }],
      }),
    ).toBeNull();
  });

  it("rejects malformed attachments and snippets", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m",
            text: "x",
            attachments: [{ mediaType: "image/png" }],
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m",
            text: "x",
            contextSnippet: { text: "y", sourceRole: "system" },
          },
        ],
      }),
    ).toBeNull();
  });

  it("drops undefined optional fields", () => {
    const parsed = parseSteerBody({
      sessionId: "s",
      messages: [{ clientMessageId: "m", text: "x", attachments: undefined }],
    });
    expect(parsed?.messages[0]).toEqual({ clientMessageId: "m", text: "x" });
  });

  it("rejects non-object payloads", () => {
    expect(parseSteerBody(null)).toBeNull();
    expect(parseSteerBody("nope")).toBeNull();
    expect(parseSteerBody([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api exec vitest run src/modules/chat/steer-body.test.ts`
Expected: FAIL — cannot find module `./steer-body.js`.

- [ ] **Step 3: Implement the parser**

Create `apps/api/src/modules/chat/steer-body.ts` (manual parser, mirroring `clarification-body.ts`):

```ts
import type {
  SteerAttachment,
  SteerContextSnippet,
  SteerMessage,
} from "./steering.js";

export const MAX_STEER_MESSAGES = 20;
export const MAX_STEER_TEXT_CHARS = 32_000;
export const MAX_STEER_ATTACHMENTS = 8;
export const MAX_STEER_ATTACHMENT_BYTES = 8_000_000;
export const MAX_STEER_CLIENT_ID_CHARS = 64;
export const MAX_STEER_SNIPPET_CHARS = 2_000;

export type ParsedSteerBody = {
  sessionId: string;
  messages: SteerMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachments(value: unknown): SteerAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STEER_ATTACHMENTS) return null;
  const attachments: SteerAttachment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const mediaType = typeof entry.mediaType === "string" ? entry.mediaType : "";
    const data = typeof entry.data === "string" ? entry.data : "";
    if (
      mediaType.length === 0 ||
      data.length === 0 ||
      data.length > MAX_STEER_ATTACHMENT_BYTES
    ) {
      return null;
    }
    attachments.push({ mediaType, data });
  }
  return attachments;
}

function parseContextSnippet(value: unknown): {
  ok: boolean;
  snippet?: SteerContextSnippet;
} {
  if (value === undefined || value === null) return { ok: true };
  if (!isRecord(value)) return { ok: false };
  const text = typeof value.text === "string" ? value.text : "";
  if (text.length === 0 || text.length > MAX_STEER_SNIPPET_CHARS) {
    return { ok: false };
  }
  if (value.sourceRole !== "user" && value.sourceRole !== "assistant") {
    return { ok: false };
  }
  return { ok: true, snippet: { text, sourceRole: value.sourceRole } };
}

function parseSteerMessage(value: unknown): SteerMessage | null {
  if (!isRecord(value)) return null;
  const clientMessageId =
    typeof value.clientMessageId === "string" ? value.clientMessageId : "";
  if (
    clientMessageId.length === 0 ||
    clientMessageId.length > MAX_STEER_CLIENT_ID_CHARS
  ) {
    return null;
  }
  const text = typeof value.text === "string" ? value.text : null;
  if (text === null || text.length > MAX_STEER_TEXT_CHARS) return null;
  const attachments = parseAttachments(value.attachments);
  if (attachments === null) return null;
  if (text.trim().length === 0 && attachments.length === 0) return null;
  const snippet = parseContextSnippet(value.contextSnippet);
  if (!snippet.ok) return null;
  return {
    clientMessageId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(snippet.snippet ? { contextSnippet: snippet.snippet } : {}),
  };
}

export function parseSteerBody(value: unknown): ParsedSteerBody | null {
  if (!isRecord(value)) return null;
  const sessionId =
    typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (sessionId.length === 0) return null;
  if (
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > MAX_STEER_MESSAGES
  ) {
    return null;
  }
  const messages: SteerMessage[] = [];
  for (const entry of value.messages) {
    const message = parseSteerMessage(entry);
    if (message === null) return null;
    messages.push(message);
  }
  return { sessionId, messages };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/modules/chat/steer-body.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat/steer-body.ts apps/api/src/modules/chat/steer-body.test.ts
git commit -m "feat(api): validated body parser for the steer endpoint"
```

### Task 3: Applied-ids sync service (anti-duplicate across reloads)

**Files:**
- Create: `apps/api/src/modules/chat/steer-sync.ts`
- Test: `apps/api/src/modules/chat/steer-sync.test.ts`

**Interfaces:**
- Consumes: `createDefaultMemoryScopeKey` from `./memory-scope.js`; `Message` from `@anvia/core/completion`; `PrismaClient` from `../../generated/prisma/client.js`.
- Produces: `createSteerSyncService(deps: { prisma: SteerSyncPrisma })`, `SteerSyncService`, `getSteerSyncService()`, `MAX_SYNC_IDS` (used by Task 4).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/chat/steer-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSteerSyncService } from "./steer-sync.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

type SteerSyncPrisma = Pick<
  PrismaClient,
  "agentMemorySession" | "agentMemoryMessage"
>;

type Row = { message: unknown };

function createFakePrisma(
  rows: Row[],
  sessionFound = true,
): SteerSyncPrisma {
  return {
    agentMemorySession: {
      async findUnique() {
        return sessionFound ? { id: "memory-session-1" } : null;
      },
    } as unknown as SteerSyncPrisma["agentMemorySession"],
    agentMemoryMessage: {
      async findMany() {
        return rows as never;
      },
    } as unknown as SteerSyncPrisma["agentMemoryMessage"],
  };
}

const userRow = (clientMessageId: string): Row => ({
  message: { role: "user", content: [], metadata: { clientMessageId } },
});

describe("createSteerSyncService.findAppliedClientMessageIds", () => {
  it("returns ids present in user memory rows", async () => {
    const service = createSteerSyncService({
      prisma: createFakePrisma([userRow("a"), userRow("b")]),
    });
    const result = await service.findAppliedClientMessageIds({
      sessionId: "s",
      userId: "u",
      ids: ["a", "b", "c"],
    });
    expect(result.sort()).toEqual(["a", "b"]);
  });

  it("ignores rows without clientMessageId metadata", async () => {
    const service = createSteerSyncService({
      prisma: createFakePrisma([
        { message: { role: "user", content: [], metadata: {} } },
        { message: { role: "user", content: [] } },
        userRow("a"),
      ]),
    });
    const result = await service.findAppliedClientMessageIds({
      sessionId: "s",
      userId: "u",
      ids: ["a"],
    });
    expect(result).toEqual(["a"]);
  });

  it("returns an empty list when the memory session is missing", async () => {
    const service = createSteerSyncService({
      prisma: createFakePrisma([userRow("a")], false),
    });
    const result = await service.findAppliedClientMessageIds({
      sessionId: "s",
      userId: "u",
      ids: ["a"],
    });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api exec vitest run src/modules/chat/steer-sync.test.ts`
Expected: FAIL — cannot find module `./steer-sync.js`.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/chat/steer-sync.ts` (DI pattern mirroring `context-snippets.ts`):

```ts
import type { Message } from "@anvia/core/completion";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { prisma as prismaClient } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

export const MAX_SYNC_IDS = 50;

export type SteerSyncPrisma = Pick<
  PrismaClient,
  "agentMemorySession" | "agentMemoryMessage"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSteerSyncService(deps: { prisma: SteerSyncPrisma }) {
  return {
    /**
     * Which of `ids` were already persisted as user messages (steered items
     * committed mid-run) — lets a re-joining client purge them from its queue.
     */
    async findAppliedClientMessageIds(input: {
      sessionId: string;
      userId: string;
      ids: string[];
    }): Promise<string[]> {
      const scopeKey = createDefaultMemoryScopeKey(input.sessionId, input.userId);
      const session = await deps.prisma.agentMemorySession.findUnique({
        where: { scopeKey },
        select: { id: true },
      });
      if (!session) return [];
      const rows = await deps.prisma.agentMemoryMessage.findMany({
        where: { memorySessionId: session.id, role: "user" },
        select: { message: true },
      });
      const wanted = new Set(input.ids);
      const applied: string[] = [];
      for (const row of rows) {
        const message = row.message as Message;
        if (!isRecord(message.metadata)) continue;
        const clientMessageId = message.metadata.clientMessageId;
        if (
          typeof clientMessageId === "string" &&
          wanted.has(clientMessageId)
        ) {
          applied.push(clientMessageId);
        }
      }
      return applied;
    },
  };
}

export type SteerSyncService = ReturnType<typeof createSteerSyncService>;

let service: SteerSyncService | null = null;

export function getSteerSyncService(): SteerSyncService {
  if (!service) {
    service = createSteerSyncService({ prisma: prismaClient });
  }
  return service;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/modules/chat/steer-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat/steer-sync.ts apps/api/src/modules/chat/steer-sync.test.ts
git commit -m "feat(api): applied-ids sync service for queued follow-up dedupe"
```

---

### Task 4: Steer + queue/sync endpoints in the chat router

**Files:**
- Modify: `apps/api/src/modules/chat/router.ts` (add imports + two routes after the `/stop` route, before `/capabilities`)

**Interfaces:**
- Consumes: `parseSteerBody` (Task 2), `getSteeringStore` (Task 1), `getSteerSyncService` + `MAX_SYNC_IDS` (Task 3), existing `ACTIVE_RUN_KEY`, `getRedis`, `getStreamStore`, `requireSessionId`.
- Produces: `POST /api/chat/steer` → `{ ok, streamId, queued }` | `400` | `404` | `409 { code: "NO_ACTIVE_RUN" }`; `POST /api/chat/queue/sync` → `{ appliedIds }` | `400`.

- [ ] **Step 1: Add imports**

At the top of `router.ts`, extend the existing imports:

```ts
import { getSteeringStore } from "./steering.js";
import { parseSteerBody } from "./steer-body.js";
import { getSteerSyncService, MAX_SYNC_IDS } from "./steer-sync.js";
```

- [ ] **Step 2: Add the routes**

Insert after the `/stop` route (which ends with `return c.json({ ok: true, cancelled });` followed by `})`) and before `.get("/capabilities", ...)`:

```ts
  .post("/steer", async (c) => {
    const user = c.get("user");
    const body = await c.req.json().catch(() => null);
    const parsed = parseSteerBody(body);
    if (!parsed) {
      return c.json(
        {
          error:
            "sessionId and messages (1-20 of { clientMessageId, text, attachments?, contextSnippet? }) are required",
        },
        400,
      );
    }
    const streamId = await getRedis().get(ACTIVE_RUN_KEY(parsed.sessionId));
    if (!streamId) {
      return c.json(
        { error: "No active run for this session", code: "NO_ACTIVE_RUN" },
        409,
      );
    }
    const meta = await getStreamStore().getMeta(streamId);
    if (!meta || meta.userId !== user.id) {
      return c.json({ error: "stream not found" }, 404);
    }
    const steering = getSteeringStore();
    let queued = 0;
    for (const message of parsed.messages) {
      if (await steering.push(streamId, message)) {
        queued += 1;
      }
    }
    return c.json({ ok: true, streamId, queued });
  })
  .post("/queue/sync", async (c) => {
    const user = c.get("user");
    const body = await c.req.json().catch(() => null);
    const record =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const sessionId = record ? requireSessionId(record.sessionId) : null;
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const rawIds = record?.ids;
    if (
      !Array.isArray(rawIds) ||
      rawIds.length === 0 ||
      rawIds.length > MAX_SYNC_IDS ||
      rawIds.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 64,
      )
    ) {
      return c.json(
        { error: "ids must be an array of 1-50 strings (max 64 chars each)" },
        400,
      );
    }
    const appliedIds = await getSteerSyncService().findAppliedClientMessageIds({
      sessionId,
      userId: user.id,
      ids: rawIds as string[],
    });
    return c.json({ appliedIds });
  })
```

- [ ] **Step 3: Typecheck the API**

Run: `pnpm --filter api build`
Expected: PASS (tsc exits 0). Fix any type errors in the new routes.

- [ ] **Step 4: Manual smoke (optional, needs running stack)**

With `pnpm dev` running (docker up): `curl -X POST http://localhost:3001/api/chat/steer -H "content-type: application/json" -d '{"sessionId":"x","messages":[]}'` with an auth cookie → expect `400`; without a valid run → `409 NO_ACTIVE_RUN` for a real session.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat/router.ts
git commit -m "feat(api): steer and queue/sync endpoints for queued follow-ups"
```

---

### Task 5: Wire the steering pump into the chat-run worker

**Files:**
- Modify: `apps/api/src/modules/chat/run-worker.ts` (request handle + pump + loop changes)

**Interfaces:**
- Consumes: `getSteeringStore`, `SteeringPump`, `SteerableRequest` from `./steering.js` (Task 1); `Message` type already imported as `MessageType`.
- Produces: worker behavior — queued messages are steered one per turn, acked via `queued_message_applied` events appended BEFORE the steered turn's `turn_start`, leftover list drained after the loop.

- [ ] **Step 1: Add imports**

In `run-worker.ts`, after the existing imports, add:

```ts
import { getSteeringStore, SteeringPump } from "./steering.js";
import type { SteerableRequest } from "./steering.js";
```

- [ ] **Step 2: Replace the request factory and stream loop**

In `processChatRunJob`, replace the block from `// The transient-retry wrapper sits between...` (the `rawFactory` const) through the `for await (const event of profiled) { ... }` loop with:

```ts
    // A narrow handle on the SDK PromptRequest: steering needs the live
    // instance, and the transient-retry wrapper rebuilds it per attempt.
    const buildRunRequest = (): SteerableRequest => {
      const request = runInput.agent
        .session(sessionId, { userId })
        .prompt(effectivePrompt)
        .withTrace({
          sessionId,
          userId,
          ...(runInput.projectId ? { projectId: runInput.projectId } : {}),
        });
      return {
        steer: (input: MessageType) => request.steer(input),
        stream: () => request.stream(),
      };
    };

    const requestRef: { current: SteerableRequest } = {
      current: buildRunRequest(),
    };

    const pump = new SteeringPump(
      streamId,
      getSteeringStore(),
      () => requestRef.current,
      async (applied) => {
        await store.append({
          streamId,
          event: {
            type: "queued_message_applied",
            clientMessageId: applied.clientMessageId,
            text: applied.text,
            attachmentCount: applied.attachments?.length ?? 0,
          },
        });
      },
    );

    // The transient-retry wrapper sits between the raw agent stream and the
    // audit taps, so a dropped attempt records nothing (no usage, no stream
    // events, no citations) — only the retried stream flows into the taps.
    const rawFactory = () => {
      requestRef.current = buildRunRequest();
      return requestRef.current.stream();
    };

    const stream = withTransientModelRetry(rawFactory, () => {
      // The rebuilt request must re-receive the not-yet-applied steer.
      pump.rearmSteer();
      return removeAppendedPromptRow(sessionId, userId, promptMessage);
    });

    // Chain (outermost → raw stream): profile refresh → finalize citations →
    // usage audit → stop flag. Profile tap outermost so the background
    // refresh is enqueued last, after the stream fully settles.
    const profiled = tapProfileRefresh(
      tapStreamComplete(
        tapAgentStreamUsage(tapStreamStopFlag(stream, streamId), {
          userId,
          sessionId,
          provider: DEFAULT_COMPLETION_PROVIDER,
          model,
          reasoningEffort,
          agentId: "my-agent",
        }),
        () => finalizeAssistantCitations(sessionId, userId),
      ),
      { userId, projectId: runInput.projectId },
    );

    for await (const event of profiled) {
      await pump.beforeEvent(event);
      await store.append({ streamId, event });
      await pump.afterEvent();
    }

    // Anything still queued never reached the model — the client owns those
    // messages and re-sends them after the stream ends.
    const drained = await pump.drain();
    if (drained > 0) {
      console.log(
        `[chat-run] ${streamId}: discarded ${drained} unsteered queued message(s)`,
      );
    }
```

Keep everything else (compaction, image context, `store.close`, `releaseActiveRun`, `failChatRun`) unchanged.

- [ ] **Step 3: Typecheck + full API tests**

Run: `pnpm --filter api build` then `pnpm --filter api test`
Expected: PASS both. The tap chain generics infer from the same iterable shape as before (the handle's `stream()` returns the SDK `AsyncIterable`), so `tapAgentStreamUsage`/`tapProfileRefresh` compile unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/run-worker.ts
git commit -m "feat(api): steer queued follow-ups into the active run from the worker"
```

### Task 6: Platform queue library (types, storage, mutations)

**Files:**
- Create: `apps/platform/src/lib/chat/queued-messages.ts`
- Test: `apps/platform/src/lib/chat/queued-messages.test.ts`

**Interfaces:**
- Consumes: `UIAttachment` from `@anvia/react`.
- Produces (used by Tasks 7–12): `QueuedItem`, `QueuedDraft`, `QueuedItemStatus`, `QueuedContextSnippet`, `queueStorageKey`, `readQueue`, `writeQueue`, `addQueuedItem`, `removeQueuedItem`, `reorderQueuedItem`, `markQueuedItemsInflight`, `revertInflightItems`, `applyQueuedAck`, `startQueuedEdit`, `finishQueuedEdit`, `cancelQueuedEdit`, `nextFlushableItem`, `pendingBeforeEditing`, `chunkIds`.

- [ ] **Step 1: Write the failing tests**

Create `apps/platform/src/lib/chat/queued-messages.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addQueuedItem,
  applyQueuedAck,
  cancelQueuedEdit,
  chunkIds,
  finishQueuedEdit,
  markQueuedItemsInflight,
  nextFlushableItem,
  pendingBeforeEditing,
  queueStorageKey,
  readQueue,
  removeQueuedItem,
  reorderQueuedItem,
  revertInflightItems,
  startQueuedEdit,
  writeQueue,
  type QueuedDraft,
  type QueuedItem,
} from "./queued-messages.js";

function createStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return { store, storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const draft: QueuedDraft = {
  text: "hello",
  attachments: [],
  documentIds: [],
  contextSnippet: null,
  pinnedImageIds: [],
};

const item = (id: string, patch: Partial<QueuedItem> = {}): QueuedItem => ({
  id,
  text: "hello",
  attachments: [],
  documentIds: [],
  contextSnippet: null,
  pinnedImageIds: [],
  status: "pending",
  ...patch,
});

describe("storage", () => {
  it("round-trips items with order preserved", () => {
    const { store } = createStorage();
    const items = [
      item("a", { text: "first" }),
      item("b", { text: "second" }),
    ];
    writeQueue("s1", items);
    expect(readQueue("s1")).toEqual(items);
    expect(store.has(queueStorageKey("s1"))).toBe(true);
  });

  it("drops invalid entries and normalizes statuses to pending", () => {
    const { store } = createStorage();
    store.set(
      queueStorageKey("s1"),
      JSON.stringify([
        item("a", { status: "editing" }),
        item("b", { status: "inflight" }),
        { id: "broken", text: 5 },
        "not-an-object",
      ]),
    );
    const restored = readQueue("s1");
    expect(restored).toHaveLength(2);
    expect(restored.every((entry) => entry.status === "pending")).toBe(true);
  });

  it("degrades to text-only items when the quota is exceeded", () => {
    const { store } = createStorage();
    const withImage = item("a", {
      attachments: [
        { id: "att-1", type: "image", name: "x.png", data: "AAAA" },
      ],
    });
    const storage = store as unknown as Storage;
    vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    writeQueue("s1", [withImage]);
    const restored = readQueue("s1");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.attachments[0]?.data).toBeUndefined();
    expect(restored[0]?.attachments[0]?.name).toBe("x.png");
  });

  it("returns an empty list for missing or corrupt storage", () => {
    const { store } = createStorage();
    expect(readQueue("s1")).toEqual([]);
    store.set(queueStorageKey("s1"), "{corrupt");
    expect(readQueue("s1")).toEqual([]);
  });
});

describe("mutations", () => {
  it("adds, removes, and reorders items", () => {
    const base: QueuedItem[] = [];
    const withA = addQueuedItem(base, item("a"));
    const withB = addQueuedItem(withA, item("b"));
    expect(withB.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(removeQueuedItem(withB, "a").map((entry) => entry.id)).toEqual(["b"]);
    expect(reorderQueuedItem(withB, 0, 1).map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
    expect(reorderQueuedItem(withB, 0, 0)).toEqual(withB);
    expect(reorderQueuedItem(withB, 5, 1)).toEqual(withB);
  });

  it("marks inflight, reverts, and acks", () => {
    const items = [item("a"), item("b")];
    const inflight = markQueuedItemsInflight(items, new Set(["a"]));
    expect(inflight[0]?.status).toBe("inflight");
    expect(inflight[1]?.status).toBe("pending");
    expect(revertInflightItems(inflight).every((entry) => entry.status === "pending")).toBe(true);
    expect(applyQueuedAck(inflight, "a").map((entry) => entry.id)).toEqual(["b"]);
  });

  it("supports the edit lifecycle without changing the slot", () => {
    const items = [item("a"), item("b")];
    const editing = startQueuedEdit(items, "a");
    expect(editing[0]?.status).toBe("editing");
    const done = finishQueuedEdit(editing, "a", { ...draft, text: "edited" });
    expect(done[0]?.text).toBe("edited");
    expect(done[0]?.status).toBe("pending");
    expect(done.map((entry) => entry.id)).toEqual(["a", "b"]);
    const cancelled = cancelQueuedEdit(editing, "a");
    expect(cancelled[0]?.text).toBe("hello");
    expect(cancelled[0]?.status).toBe("pending");
  });

  it("nextFlushableItem stops at an editing item", () => {
    expect(nextFlushableItem([item("a")])?.item.id).toBe("a");
    expect(nextFlushableItem([])).toBeNull();
    const inflight = item("a", { status: "inflight" });
    const pending = item("b");
    expect(nextFlushableItem([inflight, pending])?.item.id).toBe("b");
    const editing = item("a", { status: "editing" });
    expect(nextFlushableItem([editing, pending])).toBeNull();
  });

  it("pendingBeforeEditing collects pendings until the first editing item", () => {
    const pendingA = item("a");
    const pendingB = item("b");
    const editing = item("c", { status: "editing" });
    const pendingD = item("d");
    expect(
      pendingBeforeEditing([pendingA, pendingB, editing, pendingD]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("chunkIds splits ids into capped chunks", () => {
    expect(chunkIds(["a", "b", "c", "d"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(chunkIds([], 2)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter platform exec vitest run src/lib/chat/queued-messages.test.ts`
Expected: FAIL — cannot find module `./queued-messages.js`.

- [ ] **Step 3: Implement the library**

Create `apps/platform/src/lib/chat/queued-messages.ts`:

```ts
import type { UIAttachment } from "@anvia/react";

export type QueuedContextSnippet = {
  text: string;
  sourceRole: "user" | "assistant";
};

export type QueuedItemStatus = "pending" | "inflight" | "editing";

export type QueuedItem = {
  id: string;
  text: string;
  attachments: UIAttachment[];
  documentIds: string[];
  contextSnippet: QueuedContextSnippet | null;
  pinnedImageIds: string[];
  status: QueuedItemStatus;
};

export type QueuedDraft = Omit<QueuedItem, "id" | "status">;

export const QUEUE_STORAGE_PREFIX = "chat.queue.";

export function queueStorageKey(sessionId: string): string {
  return `${QUEUE_STORAGE_PREFIX}${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachment(value: unknown): UIAttachment | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type !== "image" && type !== "document" && type !== "file") return null;
  const id = typeof value.id === "string" ? value.id : null;
  if (id === null) return null;
  const attachment: UIAttachment = { id, type };
  if (typeof value.name === "string") attachment.name = value.name;
  if (typeof value.mediaType === "string") attachment.mediaType = value.mediaType;
  if (typeof value.data === "string") attachment.data = value.data;
  if (typeof value.url === "string") attachment.url = value.url;
  if (typeof value.text === "string") attachment.text = value.text;
  return attachment;
}

function parseSnippet(value: unknown): QueuedContextSnippet | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.text !== "string" ||
    (value.sourceRole !== "user" && value.sourceRole !== "assistant")
  ) {
    return null;
  }
  return { text: value.text, sourceRole: value.sourceRole };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

function parseQueuedItem(entry: unknown): QueuedItem | null {
  if (!isRecord(entry)) return null;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (id.length === 0) return null;
  const text = typeof entry.text === "string" ? entry.text : null;
  if (text === null) return null;
  const attachmentsRaw = entry.attachments;
  if (attachmentsRaw !== undefined && !Array.isArray(attachmentsRaw)) return null;
  const attachments = (attachmentsRaw ?? [])
    .flatMap((value) => {
      const parsed = parseAttachment(value);
      return parsed === null ? [] : [parsed];
    });
  const documentIds = parseStringArray(entry.documentIds);
  if (documentIds === null) return null;
  const pinnedImageIds = parseStringArray(entry.pinnedImageIds);
  if (pinnedImageIds === null) return null;
  const contextSnippet = parseSnippet(entry.contextSnippet);
  return {
    id,
    text,
    attachments,
    documentIds,
    contextSnippet,
    pinnedImageIds,
    // Restored items always start pending: an in-flight steer belongs to a
    // past tab session; the server dedupes re-posts per stream.
    status: "pending",
  };
}

export function readQueue(sessionId: string): QueuedItem[] {
  try {
    const raw = localStorage.getItem(queueStorageKey(sessionId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const item = parseQueuedItem(entry);
      return item === null ? [] : [item];
    });
  } catch {
    return [];
  }
}

export function writeQueue(sessionId: string, items: QueuedItem[]): void {
  const key = queueStorageKey(sessionId);
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Quota exceeded (large image data) — degrade to text/reference only.
    try {
      const degraded = items.map((item) => ({
        ...item,
        attachments: item.attachments.map((attachment) => ({
          ...attachment,
          data: undefined,
        })),
      }));
      localStorage.setItem(key, JSON.stringify(degraded));
    } catch {
      // Storage unavailable — the in-memory queue still works this session.
    }
  }
}

export function addQueuedItem(
  items: QueuedItem[],
  item: QueuedItem,
): QueuedItem[] {
  return [...items, item];
}

export function removeQueuedItem(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.filter((item) => item.id !== id);
}

export function reorderQueuedItem(
  items: QueuedItem[],
  fromIndex: number,
  toIndex: number,
): QueuedItem[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function markQueuedItemsInflight(
  items: QueuedItem[],
  ids: ReadonlySet<string>,
): QueuedItem[] {
  return items.map((item) =>
    item.status === "pending" && ids.has(item.id)
      ? { ...item, status: "inflight" }
      : item,
  );
}

export function revertInflightItems(items: QueuedItem[]): QueuedItem[] {
  return items.map((item) =>
    item.status === "inflight" ? { ...item, status: "pending" } : item,
  );
}

export function applyQueuedAck(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.filter((item) => item.id !== id);
}

export function startQueuedEdit(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.map((item) =>
    item.id === id ? { ...item, status: "editing" } : item,
  );
}

export function finishQueuedEdit(
  items: QueuedItem[],
  id: string,
  draft: QueuedDraft,
): QueuedItem[] {
  return items.map((item) =>
    item.id === id ? { ...draft, id, status: "pending" } : item,
  );
}

export function cancelQueuedEdit(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.map((item) =>
    item.id === id ? { ...item, status: "pending" } : item,
  );
}

/** First pending item; stops at the first editing item (flush waits for it). */
export function nextFlushableItem(items: QueuedItem[]): {
  index: number;
  item: QueuedItem;
} | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.status === "editing") return null;
    if (item.status === "pending") return { index, item };
  }
  return null;
}

/** Pending items in order up to (not including) the first editing item. */
export function pendingBeforeEditing(items: QueuedItem[]): QueuedItem[] {
  const pending: QueuedItem[] = [];
  for (const item of items) {
    if (item.status === "editing") break;
    if (item.status === "pending") pending.push(item);
  }
  return pending;
}

export function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter platform exec vitest run src/lib/chat/queued-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/lib/chat/queued-messages.ts apps/platform/src/lib/chat/queued-messages.test.ts
git commit -m "feat(platform): queued message store library with persistence and edit lifecycle"
```

---

### Task 7: API client functions (steer + queue/sync)

**Files:**
- Modify: `apps/platform/src/lib/api.ts` (append new exports near the other chat endpoints)

**Interfaces:**
- Consumes: `apiFetch` (existing in the same file).
- Produces: `SteerMessageInput`, `steerChatMessages`, `SteerNoActiveRunError`, `isSteerNoActiveRunError`, `syncQueuedMessageIds` (used by Tasks 8–12).

- [ ] **Step 1: Add the functions**

Append to `apps/platform/src/lib/api.ts` (after `stopChatRun` or any chat endpoint; the exact anchor is not important — keep the chat endpoints together):

```ts
export type SteerMessageInput = {
  clientMessageId: string;
  text: string;
  attachments?: { mediaType: string; data: string }[];
  contextSnippet?: { text: string; sourceRole: "user" | "assistant" } | null;
};

export class SteerNoActiveRunError extends Error {
  constructor() {
    super("No active run for this session");
    this.name = "SteerNoActiveRunError";
  }
}

export function isSteerNoActiveRunError(
  error: unknown,
): error is SteerNoActiveRunError {
  return error instanceof SteerNoActiveRunError;
}

/** Queue follow-up messages into the session's active run (steer). */
export async function steerChatMessages(input: {
  sessionId: string;
  messages: SteerMessageInput[];
}): Promise<{ ok: true; streamId: string; queued: number }> {
  const response = await apiFetch("/api/chat/steer", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response.status === 409) {
    throw new SteerNoActiveRunError();
  }
  if (!response.ok) {
    throw new Error(`Failed to send queued messages (${response.status})`);
  }
  return (await response.json()) as { ok: true; streamId: string; queued: number };
}

/** Which queued message ids were already applied to memory (missed acks). */
export async function syncQueuedMessageIds(input: {
  sessionId: string;
  ids: string[];
}): Promise<{ appliedIds: string[] }> {
  const response = await apiFetch("/api/chat/queue/sync", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to sync queued messages (${response.status})`);
  }
  return (await response.json()) as { appliedIds: string[] };
}
```

- [ ] **Step 2: Verify types**

Run: `pnpm --filter platform build`
Expected: PASS. (Check `apiFetch` returns a `Response` with `json()` and `ok`/`status` — it does; adjust the call shape to match how neighboring endpoints call it, e.g. `upsertContextSnippet`.)

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/lib/api.ts
git commit -m "feat(platform): steer and queue/sync API client functions"
```

### Task 8: Queue state hook + local snippet display

**Files:**
- Create: `apps/platform/src/hooks/use-queued-messages.ts`
- Modify: `apps/platform/src/hooks/use-context-snippet.ts` (add `setLocal`)

**Interfaces:**
- Consumes: `lib/chat/queued-messages.js` (Task 6).
- Produces: `useQueuedMessages(sessionId)` → `{ items, actions }` where `actions` is `QueueActions` (used by Tasks 10–12); `useContextSnippet` additionally returns `setLocal(snippet | null)`.

- [ ] **Step 1: Implement the hook**

Create `apps/platform/src/hooks/use-queued-messages.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addQueuedItem,
  applyQueuedAck,
  cancelQueuedEdit,
  finishQueuedEdit,
  markQueuedItemsInflight,
  readQueue,
  removeQueuedItem,
  reorderQueuedItem,
  revertInflightItems,
  startQueuedEdit,
  writeQueue,
  type QueuedDraft,
  type QueuedItem,
} from "#/lib/chat/queued-messages";

export type QueueActions = {
  queueItem(draft: QueuedDraft): void;
  removeItem(id: string): void;
  reorder(fromIndex: number, toIndex: number): void;
  startEdit(id: string): void;
  submitEdit(id: string, draft: QueuedDraft): void;
  cancelEdit(id: string): void;
  markInflight(ids: ReadonlySet<string>): void;
  revertInflight(): void;
  applyAck(id: string): void;
  replaceAll(items: QueuedItem[]): void;
};

export function useQueuedMessages(sessionId: string): {
  items: QueuedItem[];
  actions: QueueActions;
} {
  const [items, setItems] = useState<QueuedItem[]>(() => readQueue(sessionId));
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    setItems(readQueue(sessionId));
  }, [sessionId]);

  useEffect(() => {
    writeQueue(sessionId, items);
  }, [sessionId, items]);

  const update = useCallback((next: QueuedItem[]) => {
    setItems(next);
  }, []);

  const actions: QueueActions = {
    queueItem: (draft) => {
      update(
        addQueuedItem(itemsRef.current, {
          ...draft,
          id: crypto.randomUUID(),
          status: "pending",
        }),
      );
    },
    removeItem: (id) => update(removeQueuedItem(itemsRef.current, id)),
    reorder: (fromIndex, toIndex) =>
      update(reorderQueuedItem(itemsRef.current, fromIndex, toIndex)),
    startEdit: (id) => update(startQueuedEdit(itemsRef.current, id)),
    submitEdit: (id, draft) =>
      update(finishQueuedEdit(itemsRef.current, id, draft)),
    cancelEdit: (id) => update(cancelQueuedEdit(itemsRef.current, id)),
    markInflight: (ids) =>
      update(markQueuedItemsInflight(itemsRef.current, ids)),
    revertInflight: () => update(revertInflightItems(itemsRef.current)),
    applyAck: (id) => update(applyQueuedAck(itemsRef.current, id)),
    replaceAll: (next) => update(next),
  };

  return { items, actions };
}
```

- [ ] **Step 2: Add `setLocal` to the snippet hook**

In `apps/platform/src/hooks/use-context-snippet.ts`, add after `reset`:

```ts
  /**
   * Local-only display of a snippet snapshot (queued-item edit hydration):
   * does not upsert or delete server state.
   */
  const setLocal = useCallback((snippet: ContextSnippet | null) => {
    mutationRef.current += 1;
    syncSnippet(snippet);
    setError(null);
    setLoading(false);
  }, []);

  return { snippet, loading, error, refresh, setSnippet, remove, reset, setLocal };
```

- [ ] **Step 3: Verify types and tests**

Run: `pnpm --filter platform build` then `pnpm --filter platform exec vitest run src/lib/chat/queued-messages.test.ts`
Expected: PASS both.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/hooks/use-queued-messages.ts apps/platform/src/hooks/use-context-snippet.ts
git commit -m "feat(platform): queued messages state hook and local snippet display"
```

---

### Task 9: MessageQueueDock + QueueConflictDialog components

**Files:**
- Create: `apps/platform/src/components/composer/message-queue-dock.tsx`
- Create: `apps/platform/src/components/chat/queue-conflict-dialog.tsx`

**Interfaces:**
- Consumes: `QueuedItem` (Task 6); `DIALOG_PRIMARY_BUTTON_CLASS`, `DIALOG_SECONDARY_BUTTON_CLASS` from `#/components/ui/dialog-actions`; `DialogShell` from `#/components/ui/dialog-shell`; lucide icons (`CornerDownLeft`, `GripVertical`, `X`, `ChevronDown`, `ChevronUp`, `EyeOff`).
- Produces: `MessageQueueDock` props: `{ items, onSendNow, onRemove, onReorder, onRecall, onCancelEdit }`. `QueueConflictDialog` props: `{ open, onClose, onSendQueue, onSendNew }`.

- [ ] **Step 1: Implement the dock**

Create `apps/platform/src/components/composer/message-queue-dock.tsx`:

```tsx
import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  EyeOff,
  GripVertical,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import type { QueuedItem } from "#/lib/chat/queued-messages";

function itemBadges(item: QueuedItem): string[] {
  const badges: string[] = [];
  const imageCount = item.attachments.filter(
    (attachment) => attachment.type === "image",
  ).length;
  if (imageCount > 0) badges.push(`+${imageCount} img`);
  const docCount =
    item.attachments.filter((attachment) => attachment.type !== "image").length +
    item.documentIds.length;
  if (docCount > 0) badges.push(`+${docCount} doc`);
  if (item.contextSnippet) badges.push("context");
  if (item.pinnedImageIds.length > 0) badges.push(`+${item.pinnedImageIds.length} pin`);
  return badges;
}

export function MessageQueueDock({
  items,
  onSendNow,
  onRemove,
  onReorder,
  onRecall,
  onCancelEdit,
}: {
  items: QueuedItem[];
  onSendNow: () => void;
  onRemove: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRecall: (id: string) => void;
  onCancelEdit: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const dragIndexRef = useRef<number | null>(null);
  const hasPending = items.some((item) => item.status === "pending");

  if (items.length === 0) return null;

  if (hidden) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-xs text-text-muted animate-fade-in">
        <span className="font-medium">{items.length} queued</span>
        <button
          type="button"
          onClick={() => setHidden(false)}
          className="cursor-pointer rounded-md px-1.5 py-0.5 font-medium text-accent transition hover:bg-white/[0.06] active:scale-[0.97]"
        >
          Show
        </button>
      </div>
    );
  }

  const visibleItems = expanded ? items : items.slice(0, 1);
  const showLoadMore = !expanded && items.length > 1;

  return (
    <div
      role="list"
      aria-label="Queued messages"
      className="flex flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-2 animate-fade-in"
    >
      <div
        className={`chat-scroll flex flex-col gap-1.5 overflow-y-auto overscroll-contain transition-[max-height] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          expanded ? "max-h-[9.75rem]" : "max-h-10"
        }`}
      >
        {visibleItems.map((item, index) => {
          const editing = item.status === "editing";
          const badges = itemBadges(item);
          return (
            <div
              key={item.id}
              role="listitem"
              draggable={expanded && !editing}
              onDragStart={(event) => {
                dragIndexRef.current = index;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragIndexRef.current;
                dragIndexRef.current = null;
                if (from !== null && from !== index) onReorder(from, index);
              }}
              onDragEnd={() => {
                dragIndexRef.current = null;
              }}
              className={`group/queue-item flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition duration-150 ${
                editing
                  ? "border-white/[0.05] bg-white/[0.02] text-text-muted"
                  : "border-white/[0.06] bg-white/[0.03] text-text"
              }`}
            >
              {expanded && !editing ? (
                <button
                  type="button"
                  aria-label={`Reorder "${item.text}"`}
                  title="Drag to reorder"
                  className="cursor-grab text-text-faint transition hover:text-text-muted active:cursor-grabbing"
                >
                  <GripVertical className="size-3.5" strokeWidth={1.75} />
                </button>
              ) : (
                <span className="w-3.5 shrink-0" aria-hidden />
              )}
              <button
                type="button"
                disabled={editing}
                onClick={() => onRecall(item.id)}
                title={editing ? "Being edited" : "Click to edit"}
                className="min-w-0 flex-1 cursor-pointer truncate text-left disabled:cursor-default"
              >
                <span className={editing ? "italic" : ""}>
                  {editing ? "editing…" : item.text || "(image message)"}
                </span>
                {badges.length > 0 ? (
                  <span className="ml-1.5 text-[10px] font-medium text-text-faint">
                    {badges.join(" · ")}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={editing ? "Cancel edit" : `Remove "${item.text}"`}
                title={editing ? "Cancel edit" : "Remove"}
                onClick={() => (editing ? onCancelEdit(item.id) : onRemove(item.id))}
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-faint transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {showLoadMore ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] font-medium text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.97]"
            >
              load more ({items.length - 1})
            </button>
          ) : null}
          {expanded ? (
            <button
              type="button"
              aria-label="Collapse queue"
              title="Collapse"
              onClick={() => setExpanded(false)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
            >
              <ChevronUp className="size-3.5" strokeWidth={2} />
            </button>
          ) : null}
          {!expanded ? (
            <button
              type="button"
              aria-label="Expand queue"
              title="Expand"
              onClick={() => setExpanded(true)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
            >
              <ChevronDown className="size-3.5" strokeWidth={2} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Hide queue"
            title="Hide"
            onClick={() => setHidden(true)}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
          >
            <EyeOff className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        {hasPending ? (
          <button
            type="button"
            onClick={onSendNow}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.97]"
          >
            <CornerDownLeft className="size-3.5" strokeWidth={2.25} />
            Send now
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement the conflict dialog**

Create `apps/platform/src/components/chat/queue-conflict-dialog.tsx`:

```tsx
import { DialogShell } from "#/components/ui/dialog-shell";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";

export function QueueConflictDialog({
  open,
  onClose,
  onSendQueue,
  onSendNew,
}: {
  open: boolean;
  onClose: () => void;
  onSendQueue: () => void;
  onSendNew: () => void;
}) {
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Queued messages waiting"
      size="sm"
      heightMode="content"
      description="You have queued messages. Send them first, or send this message right away?"
      footer={
        <>
          <button type="button" className={DIALOG_SECONDARY_BUTTON_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={DIALOG_SECONDARY_BUTTON_CLASS} onClick={onSendNew}>
            Send new message
          </button>
          <button type="button" className={DIALOG_PRIMARY_BUTTON_CLASS} onClick={onSendQueue}>
            Send queue
          </button>
        </>
      }
    >
      <div className="px-4 py-3 text-xs leading-relaxed text-text-muted">
        The queue is paused (the previous run was stopped or failed). “Send
        queue” adds this draft to the queue and continues it. “Send new
        message” sends this draft now and keeps the queue on hold.
      </div>
    </DialogShell>
  );
}
```

- [ ] **Step 3: Verify the build**

Run: `pnpm --filter platform build`
Expected: PASS. These components are not wired yet — an unused component is fine for this commit.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/composer/message-queue-dock.tsx apps/platform/src/components/chat/queue-conflict-dialog.tsx
git commit -m "feat(platform): queue dock and hold-conflict dialog components"
```

### Task 10: Composer integration (queue/stop button, dock, edit hydration)

**Files:**
- Modify: `apps/platform/src/components/composer/chat-composer.tsx`

**Interfaces:**
- Consumes: `MessageQueueDock` (Task 9); `QueuedItem`, `QueuedDraft` (Task 6); `useComposer` from `@anvia/react-ui`; `CornerDownLeft` from lucide.
- Produces: `ChatComposer` gains props `queuedItems`, `onQueueSendNow`, `onQueueRemove`, `onQueueReorder`, `onQueueRecall`, `onQueueCancelEdit`, `editHydration`, `suppressOptimisticClear` (all optional, defaulted, so the route can wire them incrementally in Task 11).

- [ ] **Step 1: Add props**

Extend the `ChatComposer` props object and its type annotation:

```tsx
export function ChatComposer({
  sessionId,
  projectId = null,
  activeDocumentIds,
  chatStatus,
  isIngesting,
  composerError,
  attachmentErrors,
  composerInputRef,
  model,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
  onStopRun,
  onLinkedDocuments,
  onAttachmentRejected,
  onDismissAttachmentError,
  models = [],
  reasoningEfforts = [],
  modelsStatus = "loading",
  modelsError = null,
  onRetryModels = () => {},
  compaction = { phase: "idle" },
  contextUsage = null,
  contextUsageError = false,
  webSearchEnabled = false,
  webSearchAvailable = true,
  onWebSearchToggle = () => {},
  imageGenerationEnabled = false,
  imageGenerationAvailable = true,
  onImageGenerationToggle = () => {},
  imageGenSettings = {},
  onImageGenSettingsChange = () => {},
  activeContextImages = [],
  onToggleImageContext = () => {},
  contextSnippet = null,
  contextSnippetError = null,
  onRemoveContextSnippet = () => {},
  queuedItems = [],
  onQueueSendNow = () => {},
  onQueueRemove = () => {},
  onQueueReorder = () => {},
  onQueueRecall = () => {},
  onQueueCancelEdit = () => {},
  editHydration = null,
  suppressOptimisticClear = null,
}: {
  ... /* existing prop types unchanged ... */
  /** Queue dock items (send-while-streaming). */
  queuedItems?: QueuedItem[];
  onQueueSendNow?: () => void;
  onQueueRemove?: (id: string) => void;
  onQueueReorder?: (fromIndex: number, toIndex: number) => void;
  onQueueRecall?: (id: string) => void;
  onQueueCancelEdit?: (id: string) => void;
  /** Non-null when a queue item is being edited: hydrate the composer with it. */
  editHydration?: { version: number; draft: QueuedDraft | null } | null;
  /** When true at stream start, skip the optimistic composer clear (auto-flush). */
  suppressOptimisticClear?: React.RefObject<boolean> | null;
}) {
```

Add imports:

```tsx
import type { QueuedDraft, QueuedItem } from "#/lib/chat/queued-messages";
import { MessageQueueDock } from "#/components/composer/message-queue-dock";
import { CornerDownLeft } from "lucide-react";
```

- [ ] **Step 2: Hydrate / clear the composer on edit signals**

Add after the optimistic-clear effect:

```tsx
  // Queue-item edit hydration: replace the composer contents with the item's
  // draft (text + attachments). A null draft clears the editor (cancel edit).
  useEffect(() => {
    if (!editHydration) return;
    composer.setInput(editHydration.draft?.text ?? "");
    composer.setAttachments(editHydration.draft?.attachments ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per version bump
  }, [editHydration?.version]);
```

- [ ] **Step 3: Skip the optimistic clear for auto-flush runs**

Change the optimistic-clear effect body to:

```tsx
  useEffect(() => {
    if (chatStatus !== "streaming") return;
    if (suppressOptimisticClear?.current) return;
    composer.setInput("");
    composer.clearAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per stream start
  }, [chatStatus]);
```

- [ ] **Step 4: Render the dock above the input**

Insert between the `contextSnippet` chip block and the input row div:

```tsx
      <MessageQueueDock
        items={queuedItems}
        onSendNow={onQueueSendNow}
        onRemove={onQueueRemove}
        onReorder={onQueueReorder}
        onRecall={onQueueRecall}
        onCancelEdit={onQueueCancelEdit}
      />
```

- [ ] **Step 5: Swap Stop ↔ Queue while streaming**

In the bottom toolbar, replace the `{chatStatus === "streaming" ? <Composer.Stop .../> : <Composer.Submit .../>}` block with:

```tsx
            {chatStatus === "streaming" ? (
              editingItem !== null || composerHasInput ? (
                <Composer.Submit
                  aria-label="Add to queue"
                  title="Add to queue"
                  disabled={isIngesting || !modelsReady}
                  className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <CornerDownLeft className="size-4" strokeWidth={2.25} />
                </Composer.Submit>
              ) : (
                <Composer.Stop
                  aria-label="Stop"
                  title="Stop"
                  onClick={onStopRun}
                  className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-text text-canvas transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:opacity-90 active:scale-[0.96]"
                >
                  <Square className="size-3 fill-current" strokeWidth={0} />
                </Composer.Stop>
              )
            ) : (
              <Composer.Submit
                aria-label={isIngesting ? "Processing document" : "Send"}
                title={isIngesting ? "Processing document" : "Send"}
                disabled={isIngesting || !modelsReady}
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </Composer.Submit>
            )}
```

And above the `return`, next to `const busy`, add:

```tsx
  const editingItem = queuedItems.find((item) => item.status === "editing") ?? null;
  const composerHasInput =
    composer.input.trim().length > 0 || composer.attachments.length > 0;
```

- [ ] **Step 6: Enable attaching while streaming**

Change `ComposerAttachControl`'s `disabled` prop from `busy || modelsUnavailable` to `isIngesting || modelsUnavailable` (keep `ModelReasoningSwitcher` on `busy`):

```tsx
            <ComposerAttachControl
              sessionId={sessionId}
              projectId={projectId}
              activeDocumentIds={activeDocumentIds}
              disabled={isIngesting || modelsUnavailable}
              onLinkedDocuments={onLinkedDocuments}
              onRejectedFiles={onAttachmentRejected}
            />
```

- [ ] **Step 7: Verify the build**

Run: `pnpm --filter platform build`
Expected: PASS. Manual check (dev server): while a run is streaming, typing swaps Stop → Queue button; pressing Enter no longer submits (the submit handler still sends today — the queue branch arrives in Task 12; until then the queue button routes through `submitMessage` which still sends normally, acceptable mid-feature).

- [ ] **Step 8: Commit**

```bash
git add apps/platform/src/components/composer/chat-composer.tsx
git commit -m "feat(platform): queue/stop button swap, dock mount, and edit hydration in composer"
```

### Task 11: Route refactor — extract the shared send pipeline

**Files:**
- Modify: `apps/platform/src/routes/index.tsx` (behavior-preserving refactor of `submitComposerRef`)

**Interfaces:**
- Consumes: existing submit logic; `QueuedDraft` (Task 6).
- Produces (used by Task 12): `sendDraft(input: { text, attachments, documentIds, pinnedImageIds, preserveComposer? })` and `queueComposerDraft(input: { input, attachments }): Promise<QueuedDraft>` callbacks defined in `ChatSession`.

- [ ] **Step 1: Extract the document-upload block**

In `ChatSession`, add a helper above `submitComposerRef` (cut from the current submit body, lines ~2053–2163):

```tsx
  const uploadComposerDocuments = useCallback(
    async (attachments: UIAttachment[]): Promise<string[]> => {
      const documentAttachments = attachments.filter(
        (attachment) => !isImageAttachmentLike(attachment),
      );
      const documentIds: string[] = [];
      if (documentAttachments.length === 0) return documentIds;

      setIsIngesting(true);
      setIngestionItems([]);
      try {
        for (const attachment of documentAttachments) {
          const file = await resolveAttachmentFile(attachment);
          if (file.size === 0) {
            throw new Error(`File is empty: ${file.name}`);
          }
          const itemId = attachment.id || crypto.randomUUID();
          setIngestionItems((current) => [
            ...current,
            { id: itemId, filename: file.name, status: "uploading" },
          ]);
          const uploaded = await uploadDocument({ sessionId, file, projectId });
          const ready = await waitForDocumentReady({
            sessionId,
            documentId: uploaded.id,
            onStatus: (status) => {
              setIngestionItems((current) =>
                current.map((item) =>
                  item.id === itemId ? { ...item, status: status.status } : item,
                ),
              );
            },
          });
          documentIds.push(ready.id);
        }
        await refreshSessionDocuments();
        if (sessionImagesError) void refreshSessionImages();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Document processing failed";
        setComposerError(message);
        setIngestionItems((current) =>
          current.map((item) =>
            item.status === "uploading" ||
            item.status === "queued" ||
            item.status === "ocr_processing" ||
            item.status === "embedding_processing"
              ? { ...item, status: "failed" }
              : item,
          ),
        );
        throw error;
      } finally {
        setIsIngesting(false);
      }
      return documentIds;
    },
    [projectId, refreshSessionDocuments, sessionId, sessionImagesError],
  );
```

- [ ] **Step 2: Extract `sendDraft`**

Add below `uploadComposerDocuments`:

```tsx
  const sendDraft = useCallback(
    async (input: {
      text: string;
      attachments: UIAttachment[];
      documentIds: string[];
      pinnedImageIds: string[];
      preserveComposer?: boolean;
    }): Promise<void> => {
      const documentIds = [...input.documentIds];

      const uploadedImageAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        data?: string;
        text?: string;
      }> = [];
      for (const attachment of input.attachments.filter((a) =>
        isImageAttachmentLike(a),
      )) {
        const file = await resolveAttachmentFile(attachment);
        if (file.size === 0) {
          throw new Error(`File is empty: ${file.name}`);
        }
        const dims = await imageDimensionsFromFile(file);
        const meta = await uploadSessionImage({
          sessionId,
          file,
          width: dims.width,
          height: dims.height,
          projectId,
        });
        await addSessionImageContext({ sessionId, imageId: meta.id });
        const { blob, mediaType } = await fetchImageBytes(meta.id);
        uploadedImageAttachments.push({
          id: `ctx-${meta.id}`,
          type: "image",
          name: meta.prompt || "Uploaded image",
          mediaType,
          data: await blobToDataUrl(blob),
          text: meta.prompt || "Uploaded image",
        });
      }

      const contextAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        url?: string;
        data?: string;
        text?: string;
      }> = [];
      for (const imageId of input.pinnedImageIds) {
        try {
          const { blob, mediaType } = await fetchImageBytes(imageId);
          contextAttachments.push({
            id: `ctx-${imageId}`,
            type: "image",
            name: "Image context",
            mediaType,
            data: await blobToDataUrl(blob),
            text: "Image context",
          });
        } catch {
          // skip images that fail to load — the context still works
        }
      }

      const attachedDocuments = input.attachments.map((attachment) => {
        const name = attachment.name ?? "Document";
        return attachment.mediaType
          ? { name, mediaType: attachment.mediaType }
          : { name };
      });

      const contextSnippet = contextSnippetState.snippet;

      await chatRef.current!.sendMessage({
        text: input.text,
        metadata: withChatMessageMeta(undefined, {
          sessionId,
          documentIds,
          attachedDocuments,
          createdAt: new Date().toISOString(),
          clientMessageId: createClientMessageId(),
          ...(contextSnippet
            ? {
                contextSnippet: {
                  text: contextSnippet.text,
                  sourceRole: contextSnippet.sourceRole,
                },
              }
            : {}),
        }),
        attachments: [
          ...attachedDocuments.map((attachment) => ({
            id: crypto.randomUUID(),
            type: attachment.name === "Document" ? "document" : "file",
            name: attachment.name,
            mediaType: attachment.mediaType,
            text: attachment.name,
          })),
          ...uploadedImageAttachments,
          ...contextAttachments,
        ],
      });

      if (contextSnippet) {
        contextSnippetState.reset();
      }
      if (!input.preserveComposer) {
        // The route clears via the `clear` callback for manual sends; nothing
        // to do here — sendDraft is called by submitComposerRef which clears.
      }
      if (input.pinnedImageIds.length > 0) {
        await refreshActiveContext();
      }
      if (uploadedImageAttachments.length > 0) {
        void refreshSessionImages();
      }
    },
    [
      addSessionImageContext,
      contextSnippetState,
      projectId,
      refreshActiveContext,
      refreshSessionImages,
      sessionId,
    ],
  );
```

- [ ] **Step 3: Rewire `submitComposerRef` to use the helpers**

Replace the current `submitComposerRef` body (from `const trimmed = input.trim();` down to the `await sendPromise; clear(); ...` section) with:

```tsx
  submitComposerRef.current = async (
    input,
    attachments,
    chatController,
    clear,
  ) => {
    setComposerError(null);
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;

    // Queue conflict gate (Task 12 wires the modal) — bypassed for the modal's
    // own "send new" action via submitBypassRef.
    if (
      !submitBypassRef.current &&
      chatRef.current?.status !== "streaming" &&
      queuedItemsRef.current.length > 0
    ) {
      pendingManualSubmitRef.current = { input, attachments, chatController, clear };
      setQueueConflictOpen(true);
      return;
    }

    // Optimistic send: the user bubble appears the moment sendMessage is
    // called below. The stale check runs in parallel and only surfaces a
    // non-blocking notice afterwards (normal sends are non-destructive).
    const stalePromise = isSessionStale();

    // Truncate-before-send: a persisted failed tail [user, assistant
    // kind:"error"] would re-enter memory — drop it first.
    const messages = chatController.messages;
    const last = messages.at(-1);
    const secondLast = messages.at(-2);
    if (
      last?.role === "assistant" &&
      metadataKind(last.metadata) === "error" &&
      secondLast?.role === "user"
    ) {
      const userMeta = readChatMessageMeta(secondLast.metadata);
      if (userMeta.clientMessageId) {
        void truncateSessionMemory({
          sessionId,
          mode: "exclude",
          clientMessageId: userMeta.clientMessageId,
        }).catch(() => {});
      }
      chatController.setMessages(messages.slice(0, -2));
      void refreshSessionImages();
    }

    const documentIds = await uploadComposerDocuments(attachments);

    try {
      await sendDraft({
        text: trimmed,
        attachments,
        documentIds,
        pinnedImageIds: activeContextImages.map((image) => image.id),
      });
    } catch (error) {
      if (error instanceof Error) {
        setComposerError(error.message);
      }
      return;
    }

    clear();

    if (activeContextImages.length > 0) {
      setActiveContextImages([]);
    }
    setIngestionItems([]);

    if (await stalePromise) {
      setStaleDialog({ kind: "send" });
    }
  };
```

Note: `uploadComposerDocuments` and `sendDraft` throw on upload errors; the manual path surfaces them via `setComposerError` (as before).

- [ ] **Step 4: Verify no regressions**

Run: `pnpm --filter platform build` then `pnpm --filter platform test`.
Expected: PASS both. The refactor must not change manual send behavior.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/routes/index.tsx
git commit -m "refactor(platform): extract shared send pipeline for manual and queued sends"
```

### Task 12: Route orchestration (queue flow, flush, hold, ack, modal)

**Files:**
- Modify: `apps/platform/src/routes/index.tsx` (ChatSession)
- Modify: `apps/platform/src/components/composer/chat-composer.tsx` (add `clearComposerSignal` prop)

**Interfaces:**
- Consumes: `useQueuedMessages` (Task 8), queue lib (Task 6), `steerChatMessages`, `isSteerNoActiveRunError`, `syncQueuedMessageIds`, `SteerMessageInput` (Task 7), `sendDraft` + `uploadComposerDocuments` (Task 11), `QueueConflictDialog` (Task 9).
- Produces: fully working feature — queue while streaming, send now (steer), auto-flush, hold, edit lifecycle, ack bubbles, conflict modal.

- [ ] **Step 1: Add a composer clear signal to `chat-composer.tsx`**

Add prop `clearComposerSignal?: { version: number } | null` to `ChatComposer` (type + destructure with default `null`), and add this effect next to the edit-hydration effect:

```tsx
  // Queue/cancel actions clear the composer outside a status transition
  // (mid-stream clear() crashes the SDK editor — use the safe primitives).
  useEffect(() => {
    if (!clearComposerSignal) return;
    composer.setInput("");
    composer.clearAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per version bump
  }, [clearComposerSignal?.version]);
```

- [ ] **Step 2: Imports in `index.tsx`**

Add to the existing import list (near the other `#/` imports):

```tsx
import { useQueuedMessages } from "#/hooks/use-queued-messages";
import {
  nextFlushableItem,
  pendingBeforeEditing,
  chunkIds,
  type QueuedDraft,
  type QueuedItem,
} from "#/lib/chat/queued-messages";
import {
  isSteerNoActiveRunError,
  steerChatMessages,
  syncQueuedMessageIds,
  type SteerMessageInput,
} from "#/lib/api";
import { QueueConflictDialog } from "#/components/chat/queue-conflict-dialog";
```

(`MAX_SYNC_IDS` is server-side; the client uses its own chunk constant `50` — import the queue lib's `chunkIds` and pass `50`.)

- [ ] **Step 3: Queue state at the top of `ChatSession`**

Inside `ChatSession`, next to the other state declarations (after the `composerDockH` state):

```tsx
  const queuedState = useQueuedMessages(sessionId);
  const { items: queuedItems, actions: queueActions } = queuedState;
  const queuedItemsRef = useRef(queuedItems);
  queuedItemsRef.current = queuedItems;
  const [queueHold, setQueueHold] = useState(false);
  const [queueConflictOpen, setQueueConflictOpen] = useState(false);
  const autoFlushBusyRef = useRef(false);
  const autoFlushPreserveRef = useRef(false);
  const submitBypassRef = useRef(false);
  const pendingManualSubmitRef = useRef<{
    input: string;
    attachments: UIAttachment[];
    chatController: ReturnType<typeof useChat>;
    clear: () => void;
  } | null>(null);
  const [editHydration, setEditHydration] = useState<{
    version: number;
    draft: QueuedDraft | null;
  } | null>(null);
  const editHydrationVersionRef = useRef(0);
  const [clearComposerSignal, setClearComposerSignal] = useState<{
    version: number;
  } | null>(null);
  const clearSignalVersionRef = useRef(0);

  useEffect(() => {
    if (queuedItems.length === 0 && queueHold) setQueueHold(false);
  }, [queuedItems.length, queueHold]);
```

- [ ] **Step 4: Queue the composer draft (streaming submit branch)**

Add `queueComposerDraft` below `uploadComposerDocuments` (Task 11):

```tsx
  const queueComposerDraft = useCallback(
    async ({
      input,
      attachments,
    }: {
      input: string;
      attachments: UIAttachment[];
    }): Promise<void> => {
      const trimmed = input.trim();
      if (!trimmed && attachments.length === 0) return;

      let documentIds: string[] = [];
      try {
        documentIds = await uploadComposerDocuments(attachments);
      } catch {
        return; // upload failed — composerError already set, nothing queued
      }

      const imageAttachments: UIAttachment[] = [];
      for (const attachment of attachments) {
        if (!isImageAttachmentLike(attachment)) continue;
        if (attachment.url?.startsWith("blob:")) {
          try {
            const response = await fetch(attachment.url);
            const blob = await response.blob();
            imageAttachments.push({
              ...attachment,
              url: undefined,
              data: await blobToDataUrl(blob),
            });
          } catch {
            setComposerError("Could not read image attachment");
            return;
          }
        } else {
          imageAttachments.push(attachment);
        }
      }

      const snippet = contextSnippetState.snippet;
      const pinnedImageIds = activeContextImages.map((image) => image.id);

      queueActions.queueItem({
        text: trimmed,
        attachments: imageAttachments,
        documentIds,
        contextSnippet: snippet
          ? { text: snippet.text, sourceRole: snippet.sourceRole }
          : null,
        pinnedImageIds,
      });

      setClearComposerSignal({
        version: ++clearSignalVersionRef.current,
      });
      // Single-use context moved into the item: clear chip (server row) + pins.
      if (snippet) void contextSnippetState.remove().catch(() => {});
      for (const image of activeContextImages) {
        void removeSessionImageContext({ sessionId, imageId: image.id }).catch(
          () => {},
        );
      }
      if (pinnedImageIds.length > 0) void refreshActiveContext();
      void refreshSessionDocuments();
    },
    [
      activeContextImages,
      contextSnippetState,
      queueActions,
      refreshActiveContext,
      refreshSessionDocuments,
      sessionId,
      uploadComposerDocuments,
    ],
  );
```

- [ ] **Step 5: Edit lifecycle handlers**

Add after `queueComposerDraft`:

```tsx
  const handleQueueRecall = useCallback(
    (id: string) => {
      const item = queuedItemsRef.current.find((entry) => entry.id === id);
      if (!item || item.status !== "pending") return;
      queueActions.startEdit(id);
      setEditHydration({
        version: ++editHydrationVersionRef.current,
        draft: {
          text: item.text,
          attachments: item.attachments,
          documentIds: item.documentIds,
          contextSnippet: item.contextSnippet,
          pinnedImageIds: item.pinnedImageIds,
        },
      });
      contextSnippetState.setLocal(item.contextSnippet);
      for (const imageId of item.pinnedImageIds) {
        void addSessionImageContext({ sessionId, imageId }).catch(() => {});
      }
      if (item.pinnedImageIds.length > 0) void refreshActiveContext();
      focusComposer();
    },
    [
      addSessionImageContext,
      contextSnippetState,
      focusComposer,
      queueActions,
      refreshActiveContext,
      sessionId,
    ],
  );

  const handleSubmitQueueEdit = useCallback(
    async (input: string, attachments: UIAttachment[]) => {
      const editing = queuedItemsRef.current.find(
        (entry) => entry.status === "editing",
      );
      if (!editing) return;
      const trimmed = input.trim();
      if (!trimmed && attachments.length === 0) return;

      let documentIds = editing.documentIds;
      const docAttachments = attachments.filter(
        (attachment) => !isImageAttachmentLike(attachment),
      );
      if (docAttachments.length > 0) {
        try {
          const uploaded = await uploadComposerDocuments(docAttachments);
          documentIds = [...editing.documentIds, ...uploaded];
        } catch {
          return;
        }
      }

      const imageAttachments: UIAttachment[] = [];
      for (const attachment of attachments) {
        if (!isImageAttachmentLike(attachment)) continue;
        if (attachment.url?.startsWith("blob:")) {
          try {
            const response = await fetch(attachment.url);
            const blob = await response.blob();
            imageAttachments.push({
              ...attachment,
              url: undefined,
              data: await blobToDataUrl(blob),
            });
          } catch {
            setComposerError("Could not read image attachment");
            return;
          }
        } else {
          imageAttachments.push(attachment);
        }
      }

      const snippet = contextSnippetState.snippet;
      const pinnedImageIds = activeContextImages.map((image) => image.id);

      queueActions.submitEdit(editing.id, {
        text: trimmed,
        attachments: imageAttachments,
        documentIds,
        contextSnippet: snippet
          ? { text: snippet.text, sourceRole: snippet.sourceRole }
          : null,
        pinnedImageIds,
      });

      setEditHydration({ version: ++editHydrationVersionRef.current, draft: null });
      setClearComposerSignal({ version: ++clearSignalVersionRef.current });
      if (snippet) void contextSnippetState.remove().catch(() => {});
      if (pinnedImageIds.length > 0) void refreshActiveContext();
    },
    [
      activeContextImages,
      contextSnippetState,
      queueActions,
      refreshActiveContext,
      uploadComposerDocuments,
    ],
  );

  const handleQueueCancelEdit = useCallback(
    (id: string) => {
      const item = queuedItemsRef.current.find((entry) => entry.id === id);
      if (!item || item.status !== "editing") return;
      queueActions.cancelEdit(id);
      setEditHydration({ version: ++editHydrationVersionRef.current, draft: null });
      setClearComposerSignal({ version: ++clearSignalVersionRef.current });
      contextSnippetState.setLocal(null);
      for (const imageId of item.pinnedImageIds) {
        void removeSessionImageContext({ sessionId, imageId }).catch(() => {});
      }
      if (item.pinnedImageIds.length > 0) void refreshActiveContext();
    },
    [contextSnippetState, queueActions, refreshActiveContext, sessionId],
  );
```

- [ ] **Step 6: Send now (steer) + payload builder**

Add:

```tsx
  const buildSteerPayload = useCallback(
    async (item: QueuedItem): Promise<SteerMessageInput> => {
      const steerAttachments: { mediaType: string; data: string }[] = [];
      for (const attachment of item.attachments) {
        if (attachment.type !== "image") continue;
        try {
          // Record the image in the session gallery.
          const file = await resolveAttachmentFile(attachment);
          const dims = await imageDimensionsFromFile(file);
          await uploadSessionImage({
            sessionId,
            file,
            width: dims.width,
            height: dims.height,
            projectId,
          });
        } catch {
          setComposerError("Could not upload queued image");
          throw new Error("Could not upload queued image");
        }
        const raw = attachment.data ?? "";
        const base64 = raw.startsWith("data:")
          ? (raw.split(",", 2)[1] ?? "")
          : raw;
        if (base64.length === 0) continue;
        steerAttachments.push({
          mediaType: attachment.mediaType ?? "image/png",
          data: base64,
        });
      }
      for (const imageId of item.pinnedImageIds) {
        try {
          const { blob, mediaType } = await fetchImageBytes(imageId);
          const dataUrl = await blobToDataUrl(blob);
          steerAttachments.push({
            mediaType,
            data: dataUrl.split(",", 2)[1] ?? "",
          });
        } catch {
          // skip images that fail to load
        }
      }
      return {
        clientMessageId: item.id,
        text: item.text,
        ...(steerAttachments.length > 0 ? { attachments: steerAttachments } : {}),
        ...(item.contextSnippet ? { contextSnippet: item.contextSnippet } : {}),
      };
    },
    [projectId, sessionId],
  );

  const handleQueueSendNow = useCallback(async () => {
    const toSend = pendingBeforeEditing(queuedItemsRef.current);
    if (toSend.length === 0) return;
    queueActions.markInflight(new Set(toSend.map((item) => item.id)));
    try {
      const payloads: SteerMessageInput[] = [];
      for (const item of toSend) {
        payloads.push(await buildSteerPayload(item));
      }
      await steerChatMessages({ sessionId, messages: payloads });
      setQueueHold(false);
    } catch (error) {
      queueActions.revertInflight();
      if (isSteerNoActiveRunError(error)) {
        // The run ended between render and post — the auto-flush effect
        // sends it as a new run once idle.
        setQueueHold(false);
      } else {
        setComposerError(
          error instanceof Error
            ? error.message
            : "Could not send queued messages",
        );
      }
    }
  }, [buildSteerPayload, queueActions, sessionId]);
```

- [ ] **Step 7: Auto-flush effect**

Add after `handleQueueSendNow`:

```tsx
  useEffect(() => {
    if (chat.status !== "idle") return;
    if (initialMessages === null) return;
    if (queueHold || autoFlushBusyRef.current) return;
    if (nextFlushableItem(queuedItemsRef.current) === null) return;

    autoFlushBusyRef.current = true;
    void (async () => {
      try {
        // Purge items already applied server-side (missed acks across reloads).
        const ids = queuedItemsRef.current.map((item) => item.id);
        for (const chunk of chunkIds(ids, 50)) {
          try {
            const { appliedIds } = await syncQueuedMessageIds({
              sessionId,
              ids: chunk,
            });
            if (appliedIds.length > 0) {
              const applied = new Set(appliedIds);
              queueActions.replaceAll(
                queuedItemsRef.current.filter((item) => !applied.has(item.id)),
              );
            }
          } catch {
            // best-effort dedupe — a duplicate would only re-ask the agent
          }
        }
        const candidate = nextFlushableItem(queuedItemsRef.current);
        if (!candidate) return;

        const item = candidate.item;
        if (item.contextSnippet) {
          const ok = await contextSnippetState.setSnippet(
            item.contextSnippet.text,
            item.contextSnippet.sourceRole,
          );
          if (!ok) return;
        }
        for (const imageId of item.pinnedImageIds) {
          await addSessionImageContext({ sessionId, imageId }).catch(() => {});
        }

        autoFlushPreserveRef.current = true;
        try {
          await sendDraft({
            text: item.text,
            attachments: item.attachments,
            documentIds: item.documentIds,
            pinnedImageIds: item.pinnedImageIds,
            preserveComposer: true,
          });
        } finally {
          autoFlushPreserveRef.current = false;
        }
        queueActions.removeItem(item.id);
      } finally {
        autoFlushBusyRef.current = false;
      }
    })();
  }, [
    chat.status,
    contextSnippetState,
    initialMessages,
    queueActions,
    queueHold,
    queuedItems,
    sendDraft,
    sessionId,
  ]);
```

- [ ] **Step 8: Ack + hold wiring in event handlers**

In `handleChatEvent`, add before the `error` branch:

```tsx
      if (record.type === "queued_message_applied") {
        const clientMessageId =
          typeof record.clientMessageId === "string"
            ? record.clientMessageId
            : null;
        if (clientMessageId) {
          const item = queuedItemsRef.current.find(
            (entry) => entry.id === clientMessageId,
          );
          if (item) {
            chatRef.current?.setMessages((current) => {
              const exists = current.some(
                (message) =>
                  message.role === "user" &&
                  readChatMessageMeta(message.metadata).clientMessageId ===
                    clientMessageId,
              );
              if (exists) return current;
              const parts: UIMessage["parts"] = [
                ...item.attachments.map((attachment) => ({
                  id: crypto.randomUUID(),
                  type: "attachment" as const,
                  attachment,
                })),
              ];
              if (item.text.trim().length > 0) {
                parts.push({
                  id: crypto.randomUUID(),
                  type: "text",
                  text: item.text,
                });
              }
              return [
                ...current,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts,
                  metadata: withChatMessageMeta(undefined, {
                    sessionId,
                    clientMessageId,
                    createdAt: new Date().toISOString(),
                    documentIds: item.documentIds,
                    ...(item.contextSnippet
                      ? { contextSnippet: item.contextSnippet }
                      : {}),
                  }),
                },
              ];
            });
            queueActions.applyAck(clientMessageId);
            if (item.attachments.length > 0) void refreshSessionImages();
          }
        }
        return;
      }
```

In the `error` branch of `handleChatEvent`, after `setComposerError(...)`, add `setQueueHold(true);`. (Add `setQueueHold` to the `useCallback` deps — it is a state setter, stable.)

In `handleStopRun`, after `current.reset(...)`, add `setQueueHold(true);`.

- [ ] **Step 9: Conflict modal handlers**

Add near `handleStopRun`:

```tsx
  const handleQueueConflictSendQueue = useCallback(async () => {
    setQueueConflictOpen(false);
    const pending = pendingManualSubmitRef.current;
    pendingManualSubmitRef.current = null;
    if (!pending) return;
    await queueComposerDraft({
      input: pending.input,
      attachments: pending.attachments,
    });
    setQueueHold(false);
  }, [queueComposerDraft]);

  const handleQueueConflictSendNew = useCallback(async () => {
    setQueueConflictOpen(false);
    const pending = pendingManualSubmitRef.current;
    pendingManualSubmitRef.current = null;
    if (!pending) return;
    submitBypassRef.current = true;
    try {
      await submitComposerRef.current(
        pending.input,
        pending.attachments,
        pending.chatController,
        pending.clear,
      );
    } finally {
      submitBypassRef.current = false;
    }
  }, []);
```

- [ ] **Step 10: Branch the Composer.Root submit handler**

Replace the `submitMessage={...}` callback body with:

```tsx
        submitMessage={async ({
          input,
          attachments,
          chat: chatController,
          clear,
        }) => {
          if (modelsStatus !== "success") return;
          const editing = queuedItemsRef.current.find(
            (item) => item.status === "editing",
          );
          if (chatRef.current?.status === "streaming") {
            if (editing) {
              await handleSubmitQueueEdit(input, attachments);
            } else {
              await queueComposerDraft({ input, attachments });
            }
            return;
          }
          await submitComposerRef.current(
            input,
            attachments,
            chatController,
            clear,
          );
        }}
```

- [ ] **Step 11: Wire props into `ChatComposer` and mount the dialog**

On the `<ChatComposer ...>` JSX, add:

```tsx
          queuedItems={queuedItems}
          onQueueSendNow={handleQueueSendNow}
          onQueueRemove={queueActions.removeItem}
          onQueueReorder={queueActions.reorder}
          onQueueRecall={handleQueueRecall}
          onQueueCancelEdit={handleQueueCancelEdit}
          editHydration={editHydration}
          clearComposerSignal={clearComposerSignal}
          suppressOptimisticClear={autoFlushPreserveRef}
```

Next to the stale dialog (or any sibling inside the route's tree), add:

```tsx
      <QueueConflictDialog
        open={queueConflictOpen}
        onClose={() => {
          pendingManualSubmitRef.current = null;
          setQueueConflictOpen(false);
        }}
        onSendQueue={() => void handleQueueConflictSendQueue()}
        onSendNew={() => void handleQueueConflictSendNew()}
      />
```

- [ ] **Step 12: Verify**

Run: `pnpm --filter platform build` then `pnpm --filter platform test` and `pnpm --filter api test`.
Expected: PASS all. Fix any TS errors (unused imports, prop mismatch in ChatComposer, effect deps).

- [ ] **Step 13: Commit**

```bash
git add apps/platform/src/routes/index.tsx apps/platform/src/components/composer/chat-composer.tsx
git commit -m "feat(platform): queue orchestration — steer, auto-flush, hold, edit, and conflict dialog"
```

### Task 13: E2E tests (stub scenario + browser suite)

**Files:**
- Modify: `apps/platform/e2e/stub-openrouter.ts` (slow scenario)
- Create: `apps/platform/e2e/queued-follow-ups.e2e.ts`

**Interfaces:**
- Consumes: existing stub helpers + `startStubServer`; the Playwright helpers copied from `image-generation.e2e.ts`.
- Produces: 3 browser tests covering queue-while-streaming + steer, stop/hold + conflict dialog, reload persistence + auto-flush.

- [ ] **Step 1: Add a slow text scenario to the stub**

In `stub-openrouter.ts`:
1. Change the `Scenario` union to include `"slow"` and add to `scenarioFor`: `if (text.includes("lambat")) return "slow";`
2. Add a chunked-stream helper (deltas split on spaces):

```ts
function slowTextStream(text: string): { head: string[]; deltas: string[]; tail: string[] } {
  const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
  const responseId = `resp_${Math.random().toString(36).slice(2, 10)}`;
  const part = { type: "output_text", text, annotations: [] };
  const messageItem = {
    id: messageId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const response = {
    id: responseId,
    object: "response",
    status: "completed",
    model: "stub-model",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const head = [
    sse("response.created", {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 1,
      item_id: messageId,
      output_index: 0,
      item: { ...messageItem, status: "in_progress", content: [] },
    }),
    sse("response.content_part.added", {
      type: "response.content_part.added",
      sequence_number: 2,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: "" },
    }),
  ];
  const words = text.split(" ");
  const deltas = words.map((word, index) =>
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 3 + index,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: `${word} `,
    }),
  );
  const tail = [
    sse("response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: 3 + words.length,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    }),
    sse("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: 4 + words.length,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part,
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 5 + words.length,
      output_index: 0,
      item: messageItem,
    }),
    sse("response.completed", {
      type: "response.completed",
      response: { ...response, output: [messageItem], sequence_number: 6 + words.length },
    }),
  ];
  return { head, deltas, tail };
}
```

3. Make `handleResponses` async and add the slow branch BEFORE the generic `textStream` fallback:

```ts
  if (scenario === "slow") {
    const { head, deltas, tail } = slowTextStream(
      `Selesai: slow (turn ${turn})`,
    );
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of head) res.write(event);
    for (const delta of deltas) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      res.write(delta);
    }
    for (const event of tail) res.write(event);
    res.end();
    return;
  }
```

Also add `async` to `handleResponses`'s signature and `await handleResponses(...)` at the call site (the `/api/v1/responses` branch).

- [ ] **Step 2: Write the e2e tests**

Create `apps/platform/e2e/queued-follow-ups.e2e.ts` (helpers copied from `image-generation.e2e.ts`):

```ts
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const STUB_ORIGIN = "http://127.0.0.1:18765";
const API_ORIGIN = "http://localhost:3001";

const editorLocator = (page: Page) =>
  page.locator("[data-anvia-composer-editor]");

async function openFreshChat(page: Page): Promise<void> {
  const draftResponse = await page.request.post(
    `${API_ORIGIN}/api/chat/sessions/draft`,
    { data: { projectId: null } },
  );
  expect(draftResponse.ok()).toBe(true);
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await expect(
    page.getByText("Ask anything about your documents"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(editorLocator(page)).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially(text);
  await editor.press("Enter");
}

async function resetStub(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${STUB_ORIGIN}/__reset`);
  expect(response.ok()).toBe(true);
}

async function stubRequests(
  request: APIRequestContext,
): Promise<Record<string, unknown>[]> {
  const response = await request.get(`${STUB_ORIGIN}/__requests`);
  const data = (await response.json()) as { requests: unknown[] };
  return data.requests as Record<string, unknown>[];
}

function responsesLastUserTexts(requests: Record<string, unknown>[]): string[] {
  return requests
    .filter((entry) => entry.kind === "responses")
    .map((entry) => {
      const body = (entry.body ?? {}) as { input?: unknown };
      const input = Array.isArray(body.input) ? body.input : [];
      for (let index = input.length - 1; index >= 0; index -= 1) {
        const item = input[index] as Record<string, unknown> | undefined;
        if (!item || item.role !== "user") continue;
        if (typeof item.content === "string") return item.content;
        if (Array.isArray(item.content)) {
          return item.content
            .map((part) =>
              typeof (part as { text?: unknown } | null)?.text === "string"
                ? ((part as { text: string }).text)
                : "",
            )
            .join(" ");
        }
      }
      return "";
    });
}

async function waitForRunDone(page: Page): Promise<void> {
  await expect(page.getByText(/Selesai:/).last()).toBeVisible({
    timeout: 30_000,
  });
}

test.beforeEach(async ({ request }) => {
  await resetStub(request);
});

test("queues a follow-up while streaming and steers it into the same run", async ({
  page,
  request,
}) => {
  await openFreshChat(page);
  await sendMessage(page, "jawab dengan lambat");
  await expect(page.getByText(/Selesai: slow \(turn 1\)/).last()).toBeVisible({
    timeout: 30_000,
  });

  // Stream is open: typing + Enter queues instead of sending.
  await sendMessage(page, "tambahan: sebutkan warnanya");
  await expect(
    page.getByRole("listitem").filter({ hasText: "tambahan: sebutkan warnanya" }),
  ).toBeVisible();
  await expect(editorLocator(page)).toHaveText("");

  await page.getByRole("button", { name: "Send now" }).click();

  // The steered turn flows through the SAME stream and finishes the run.
  await waitForRunDone(page);

  const texts = responsesLastUserTexts(await stubRequests(request));
  expect(texts.some((text) => text.includes("jawab dengan lambat"))).toBe(true);
  expect(texts.some((text) => text.includes("tambahan: sebutkan warnanya"))).toBe(
    true,
  );
});

test("stop holds the queue and the conflict dialog resumes it", async ({
  page,
  request,
}) => {
  await openFreshChat(page);
  await sendMessage(page, "jawab dengan lambat");
  await expect(page.getByText(/Selesai: slow \(turn 1\)/).last()).toBeVisible({
    timeout: 30_000,
  });

  await sendMessage(page, "pesan antrean");
  await expect(
    page.getByRole("listitem").filter({ hasText: "pesan antrean" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send now" })).toBeVisible();

  // Manual send with a held queue → conflict dialog → Send queue.
  await sendMessage(page, "pesan langsung");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Send queue", exact: true }).click();

  // The queued item flushes first, then the appended draft.
  await waitForRunDone(page);
  await waitForRunDone(page);

  const texts = responsesLastUserTexts(await stubRequests(request));
  expect(texts.some((text) => text.includes("pesan antrean"))).toBe(true);
  expect(texts.some((text) => text.includes("pesan langsung"))).toBe(true);
});

test("queue persists across reload and auto-flushes", async ({
  page,
  request,
}) => {
  await openFreshChat(page);
  await sendMessage(page, "jawab dengan lambat");
  await expect(page.getByText(/Selesai: slow \(turn 1\)/).last()).toBeVisible({
    timeout: 30_000,
  });

  await sendMessage(page, "pesan bertahan");
  await expect(
    page.getByRole("listitem").filter({ hasText: "pesan bertahan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();

  await page.reload();
  await expect(
    page.getByRole("listitem").filter({ hasText: "pesan bertahan" }),
  ).toBeVisible({ timeout: 30_000 });

  // Hold is in-memory: after reload the queue auto-flushes.
  await waitForRunDone(page);
  const texts = responsesLastUserTexts(await stubRequests(request));
  expect(texts.some((text) => text.includes("pesan bertahan"))).toBe(true);
});
```

Note: `waitForRunDone` twice in the second test waits for the two consecutive runs (each ends with a "Selesai:" text). If the second run's text is identical to the first, use `expect(...).toHaveCount(2)`-style waiting or assert on the stub requests instead (the stub assertion at the end is authoritative; the double wait is a practical timing aid).

- [ ] **Step 3: Run the suite**

Prereqs per README: docker compose up + migrated DB; free ports 3000/3001/18765; no provider env vars in the shell.
Run: `pnpm --filter platform exec playwright test`
Expected: all existing image-generation tests + the 3 new tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/e2e/stub-openrouter.ts apps/platform/e2e/queued-follow-ups.e2e.ts
git commit -m "test(e2e): queued follow-ups — steer, hold dialog, and reload persistence"
```

---

### Task 14: Docs + full verification

**Files:**
- Modify: `README.md` (feature row, API table, frontend notes)

- [ ] **Step 1: Update README**

- Feature table: add `| Queued follow-ups | Kirim chat saat streaming — antrean per session, steer ke run aktif (1/turn FIFO), auto-flush, hold setelah stop/error, edit + drag reorder, persist di localStorage |`.
- API chat table: add rows for `POST /api/chat/steer` (queue follow-ups into the active run; `409 NO_ACTIVE_RUN` when idle) and `POST /api/chat/queue/sync` (returns `appliedIds` for queue dedupe).
- Notes: add a bullet — queue per session disimpan di `localStorage` (`chat.queue.<sessionId>`); steer events muncul sebagai `queued_message_applied` di stream.

- [ ] **Step 2: Full verification pass**

Run in order and confirm zero failures:

```bash
pnpm --filter api test
pnpm --filter api build
pnpm --filter platform test
pnpm --filter platform build
pnpm --filter @assingment/agent test
pnpm --filter platform exec playwright test
```

Expected: everything passes with no new warnings (tsc clean, vitest green, Playwright green including the pre-existing image-generation suite).

- [ ] **Step 3: Final review + commit**

Run `git status` and `git log --oneline -15` — confirm only intended files. Fix anything outstanding, then:

```bash
git add README.md
git commit -m "docs: document queued follow-ups feature"
```

---

## Self-Review (performed after writing)

- **Spec coverage**: steering store/pump (spec §3.2 → Tasks 1, 5); steer endpoint + validation (§3.1 → Tasks 2, 4); queue/sync dedupe (§3.3 → Tasks 3, 4); queue data model + localStorage (§2 → Task 6); api client (§4.2 → Task 7); hook + edit lifecycle (§4.1, §4.2 → Tasks 8, 12); dock UI collapsed/expanded/hide/dnd (§4.4 → Task 9); conflict dialog (§4.3 → Tasks 9, 12); composer button swap + attach enable + edit hydration (§4.5 → Tasks 10, 12); send pipeline reuse (§4.3 → Task 11); auto-flush + hold + ack bubbles (§4.3, §4.5 → Task 12); e2e (§7 → Task 13); README + verification (§7 → Task 14).
- **Placeholder scan**: no TBD/TODO; every step has concrete code or exact commands.
- **Type consistency**: `SteerMessage`, `QueuedItem`, `QueuedDraft`, `nextFlushableItem`, `pendingBeforeEditing`, `chunkIds`, `SteeringPump.beforeEvent/afterEvent/rearmSteer/drain`, `QueueActions` — names match between production and test code in every task.
- Known simplifications (accepted, documented in spec §5/§6): images sent via steer are re-uploaded to the gallery at send-now time; a rare duplicate upload can occur if a steer payload build fails midway (same as today's manual-send failure behavior).







