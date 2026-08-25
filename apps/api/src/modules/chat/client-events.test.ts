import { describe, expect, it } from "vitest";
import {
  CLIENT_STREAM_PROTOCOL,
  parseClientStreamEvent,
} from "@anvia/client";
import type { AgentStreamEvent } from "@anvia/core/agent";
import {
  ChatMetadataSchema,
  ChatDataSchemas,
  createChatClientStream,
  mapChatAppEvent,
  toChatResumableEvent,
  type ChatAppEvent,
  type ChatClientEvent,
  type ChatStreamEvent,
} from "./client-events.js";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function outcome(type: "response" | "interaction" | "blocked"): AgentStreamEvent {
  const base = {
    runId: "run-1",
    text: type === "response" ? "done" : "",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    messages: [],
  };
  if (type === "response") return { ...base, type, output: "done" } as unknown as AgentStreamEvent;
  if (type === "blocked") {
    return { ...base, type, stage: "output", reason: "blocked" } as unknown as AgentStreamEvent;
  }
  return {
    ...base,
    type,
    interaction: {
      type: "tool-approval",
      id: "interaction-1",
      toolName: "web_search",
      toolCallId: "call-1",
      internalCallId: "internal-1",
      input: { query: "safe" },
    },
    continuation: {
      version: 1,
      agentId: "chat-agent",
      sourceRunId: "run-1",
      interaction: {
        type: "tool-approval",
        id: "interaction-1",
        toolName: "web_search",
        toolCallId: "call-1",
        internalCallId: "internal-1",
        input: { query: "safe" },
      },
      state: {},
    },
  } as unknown as AgentStreamEvent;
}

const metadata = {
  sessionId: "session-1",
  modelId: "deepseek-v4",
  reasoningEffort: "max",
};

describe("createChatClientStream", () => {
  it("maps standard agent events once and closes a response run", async () => {
    const source: AgentStreamEvent[] = [
      { type: "turn_start", turn: 1, prompt: { role: "user", content: "hi" }, history: [] },
      { type: "text_delta", turn: 1, delta: "hello" },
      outcome("response"),
    ];

    const events = await collect(createChatClientStream({ runId: "run-1", metadata, events: toAsync(source) }));
    expect(events.filter((event) => event.type === "run_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "completed", runId: "run-1" });
    expect(events.every((event) => event.runId === "run-1")).toBe(true);
  });

  it("maps only privacy-safe named app data events", async () => {
    const appEvents: ChatStreamEvent[] = [
      {
        type: "deep_research_progress",
        phase: "researching",
        message: "Searching sources",
        activities: [{ id: "a1", kind: "retrieval", label: "Web search", status: "active" }],
        stats: { retrievalCalls: 1, retrievalLimit: 8 },
      },
      { type: "queued_message_applied", clientMessageId: "client-1", text: "do not forward", attachmentCount: 1 },
      outcome("response"),
    ];

    const events = await collect(createChatClientStream({ runId: "run-1", metadata, events: toAsync(appEvents) }));
    const data = events.filter((event) => event.type === "data");
    expect(data).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "deepResearchProgress" }),
      expect.objectContaining({ name: "queuedMessageApplied", data: { clientMessageId: "client-1", attachmentCount: 1 } }),
    ]));
    expect(JSON.stringify(data)).not.toContain("do not forward");
    expect(() => parseClientStreamEvent(data[0], { metadataSchema: ChatMetadataSchema, dataSchemas: ChatDataSchemas })).not.toThrow();
  });

  it("omits absent optional progress fields from strict protocol-v3 JSON", async () => {
    const events = await collect(createChatClientStream({
      runId: "run-1",
      metadata,
      events: toAsync([
        {
          type: "deep_research_progress",
          phase: "planning",
          message: "Planning research",
        },
        outcome("response"),
      ] as ChatStreamEvent[]),
    }));
    const progress = events.find(
      (event) => event.type === "data" && event.name === "deepResearchProgress",
    );
    expect(progress).toBeDefined();
    expect(progress).not.toHaveProperty("data.activities");
    expect(progress).not.toHaveProperty("data.stats");
    expect(() => toChatResumableEvent(progress!)).not.toThrow();
  });

  it("passes the native memory_compaction event through the v1 client adapter", async () => {
    const nativeCompaction = {
      type: "memory_compaction",
      runId: "run-1",
      originalMessageCount: 4,
      compactedMessageCount: 2,
      retainedMessageCount: 2,
      originalTokenCount: 100,
      compactedTokenCount: 50,
      retainedTokenCount: 50,
      resultTokenCount: 70,
      attempts: 1,
      usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90 },
    } as unknown as AgentStreamEvent;
    const events = await collect(createChatClientStream({
      runId: "run-1",
      metadata,
      events: toAsync([nativeCompaction, outcome("response")]),
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "memory_compaction",
        originalMessageCount: 4,
        compactedMessageCount: 2,
        retainedMessageCount: 2,
        attempts: 1,
      }),
    ]));
    expect(events.some((event) =>
      event.type === "data" && String(event.name) === "compactionStatus",
    )).toBe(false);
  });

  it("waits for interaction persistence before yielding interaction and suspended terminal", async () => {
    let resolve!: () => void;
    const persistence = new Promise<void>((done) => { resolve = done; });
    const pending = createChatClientStream({
      runId: "run-1",
      metadata,
      events: toAsync([outcome("interaction")]),
      onInteraction: async () => persistence,
    });
    const iterator = pending[Symbol.asyncIterator]();
    await iterator.next();
    const blocked = iterator.next();
    await Promise.resolve();
    expect(await Promise.race([blocked.then(() => "yielded"), Promise.resolve("waiting")])).toBe("waiting");
    resolve();
    const events = [await blocked];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next);
      next = await iterator.next();
    }
    expect(events.map((entry) => entry.value?.type)).toContain("interaction");
    expect(events.map((entry) => entry.value?.type)).toContain("run_end");
    expect(events.find((entry) => entry.value?.type === "run_end")?.value).toMatchObject({ status: "suspended" });
  });

  it("turns a persistence failure into an error terminal", async () => {
    const events = await collect(createChatClientStream({
      runId: "run-1",
      metadata,
      events: toAsync([outcome("interaction")]),
      onInteraction: async () => { throw new Error("persist failed"); },
    }));
    expect(events.map((event) => event.type)).toEqual(["run_start", "error", "run_end"]);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "error" });
  });

  it("maps blocked outcomes without exposing a successful terminal", async () => {
    const events = await collect(createChatClientStream({ runId: "run-1", metadata, events: toAsync([outcome("blocked")]) }));
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "blocked" });
    expect(events.some((event) => event.type === "interaction")).toBe(false);
  });

  it("converts a source that ends without a root outcome into an error terminal", async () => {
    const events = await collect(createChatClientStream({
      runId: "run-1",
      metadata,
      events: toAsync([{ type: "turn_start", turn: 1, prompt: { role: "user", content: "hi" }, history: [] } as AgentStreamEvent]),
    }));
    expect(events.map((event) => event.type)).toEqual(["run_start", "turn_start", "error", "run_end"]);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "error" });
  });

  it("keeps an agent error in the standard error event and error terminal", async () => {
    const errorEvent = { type: "error", error: new Error("provider failed"), usage: {} } as unknown as AgentStreamEvent;
    const events = await collect(createChatClientStream({ runId: "run-1", metadata, events: toAsync([errorEvent]) }));
    expect(events.map((event) => event.type)).toEqual(["run_start", "error", "run_end"]);
    expect(events[1]).toMatchObject({ type: "error", error: { message: expect.any(String) } });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "error" });
  });

  it("keeps nested terminal events scoped and does not close the root run", async () => {
    const nested = {
      type: "agent_tool_event",
      turn: 1,
      toolName: "deep_research",
      internalCallId: "nested-1",
      agentId: "researcher",
      event: outcome("response"),
    } as unknown as AgentStreamEvent;
    const events = await collect(createChatClientStream({
      runId: "run-1",
      metadata,
      events: toAsync([nested, outcome("response")]),
    }));
    const terminals = events.filter((event) => event.type === "run_end");
    expect(terminals.filter((event) => event.scope === undefined)).toHaveLength(1);
    expect(terminals.filter((event) => event.scope !== undefined)).toHaveLength(1);
    expect(terminals.find((event) => event.scope === undefined)).toMatchObject({ status: "completed" });
  });

  it("rejects nested prompt/reasoning fields before they can enter app data", () => {
    expect(() => mapChatAppEvent({
      type: "deep_research_progress",
      phase: "researching",
      message: "safe",
      activities: [{ id: "a", kind: "retrieval", label: "x", status: "active", prompt: "secret" }],
    } as never, { runId: "run-1" })).toThrow();
  });

  it("rejects oversized or non-monotonic progress payloads before persistence", async () => {
    const events = await collect(createChatClientStream({
      runId: "run-1",
      metadata,
      events: toAsync([
        { type: "deep_research_progress", phase: "researching", message: "safe", stats: { retrievalCalls: 9, retrievalLimit: 8 } },
      ] as ChatStreamEvent[]),
    }));
    expect(events.map((event) => event.type)).toEqual(["run_start", "error", "run_end"]);
    expect(events.some((event) => event.type === "data")).toBe(false);
  });

  it("exposes the v3 protocol constant through canonical event envelopes", () => {
    expect(CLIENT_STREAM_PROTOCOL).toBe("anvia.client.v3");
  });
});

async function* toAsync<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) yield value;
}

void ({} as ChatClientEvent);
