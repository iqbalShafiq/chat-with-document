import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  CLIENT_STREAM_PROTOCOL,
  parseClientStreamFrame,
} from "@anvia/client";
import {
  createMemoryResumableStreamStore,
  type ResumableStreamStore,
} from "@anvia/server";

const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const STREAM_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

const metadata = {
  sessionId: SESSION_ID,
  documentIds: [],
  modelId: "deepseek/deepseek-v4-flash-0731",
  reasoningEffort: "max",
  webSearchEnabled: false,
  imageGenerationEnabled: false,
  deepResearchEnabled: false,
  imageGenSettings: null,
};

const streamEvent = {
  protocol: CLIENT_STREAM_PROTOCOL,
  event: {
    type: "run_start" as const,
    runId: "run-1",
    source: "agent" as const,
    metadata: {
      sessionId: SESSION_ID,
      modelId: metadata.modelId,
      reasoningEffort: metadata.reasoningEffort,
    },
  },
};

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", {
      id: USER_ID,
      email: "ada@example.com",
      name: "Ada Lovelace",
      image: null,
    });
    await next();
  },
}));

vi.mock("../../lib/resumable-stream-store.js", () => ({
  getStreamStore: vi.fn(),
}));

vi.mock("./approval-registry.js", () => ({
  getApprovalRegistry: vi.fn(() => ({
    listPendingApprovals: vi.fn(async () => []),
    listPendingClarifications: vi.fn(async () => []),
  })),
}));

import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { chatRouter } from "./router.js";

const app = new Hono().route("/api/chat", chatRouter);

async function createStore(options: { events?: unknown[]; completed?: boolean } = {}): Promise<ResumableStreamStore<typeof streamEvent>> {
  const store = createMemoryResumableStreamStore<typeof streamEvent>();
  await store.open({ streamId: STREAM_ID });
  for (const event of options.events ?? [streamEvent]) {
    await store.append({ streamId: STREAM_ID, event: event as typeof streamEvent });
  }
  if (options.completed !== false) await store.close({ streamId: STREAM_ID, status: "completed" });
  return store;
}

async function readFrames(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("canonical Anvia v1 chat stream response", () => {
  beforeEach(async () => {
    const store = await createStore();
    vi.mocked(getStreamStore).mockReturnValue({
      ...store,
      getMeta: vi.fn(async () => ({
        userId: USER_ID,
        sessionId: SESSION_ID,
        modelId: metadata.modelId,
        reasoningEffort: metadata.reasoningEffort,
      })),
    } as never);
  });

  it("returns protocol-v3 JSONL frames for a canonical cursor request", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "messages",
        messages: [{ role: "user", content: "resume only" }],
        metadata,
        resume: { streamId: STREAM_ID, after: 0 },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-anvia-stream-protocol")).toBe(CLIENT_STREAM_PROTOCOL);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const frames = await readFrames(response);
    expect(frames[0]).toMatchObject({
      type: "stream_start",
      protocol: CLIENT_STREAM_PROTOCOL,
      streamId: STREAM_ID,
      eventId: 0,
      resumable: true,
    });
    expect(frames.at(-1)).toMatchObject({
      type: "stream_end",
      streamId: STREAM_ID,
      status: "completed",
    });
    expect(frames.map((frame) => (frame as { eventId: number }).eventId)).toEqual([0, 1, 1]);
    for (const frame of frames) {
      expect(() => parseClientStreamFrame(frame)).not.toThrow();
    }
  });

  it("replays only records after N and emits exactly one terminal frame", async () => {
    const store = await createStore({ events: [streamEvent, { ...streamEvent, event: { ...streamEvent.event, runId: "run-2" } }] });
    vi.mocked(getStreamStore).mockReturnValue({ ...store, getMeta: vi.fn(async () => ({ userId: USER_ID, sessionId: SESSION_ID, modelId: metadata.modelId, reasoningEffort: metadata.reasoningEffort })) } as never);
    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "messages", messages: [{ role: "user", content: "resume" }], metadata, resume: { streamId: STREAM_ID, after: 1 } }) });
    expect(response.status).toBe(200);
    const frames = await readFrames(response);
    expect(frames.filter((frame) => frame.type === "stream_end")).toHaveLength(1);
    expect(frames.map((frame) => frame.eventId)).toEqual([0, 2, 2]);
  });

  it("rejects a stale cursor before opening a protocol stream", async () => {
    const store = await createStore();
    vi.mocked(getStreamStore).mockReturnValue({ ...store, getMeta: vi.fn(async () => ({ userId: USER_ID, sessionId: SESSION_ID, modelId: metadata.modelId, reasoningEffort: metadata.reasoningEffort })), status: vi.fn(async () => ({ status: "completed", lastEventId: 1 })) } as never);
    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "messages", messages: [{ role: "user", content: "resume" }], metadata, resume: { streamId: STREAM_ID, after: 2 } }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RESUME_CURSOR_INVALID" });
    expect(response.headers.get("x-anvia-stream-protocol")).toBeNull();
  });

  it("closes a running stream with one error terminal frame", async () => {
    const completed = await createStore();
    const finiteRunningStore = {
      ...completed,
      status: vi.fn(async () => ({ status: "running" as const, lastEventId: 1 })),
      subscribe: async function* ({ after }: { after?: number }) {
        if ((after ?? 0) < 1) yield { streamId: STREAM_ID, eventId: 1, event: streamEvent };
      },
    };
    vi.mocked(getStreamStore).mockReturnValue({ ...finiteRunningStore, getMeta: vi.fn(async () => ({ userId: USER_ID, sessionId: SESSION_ID, modelId: metadata.modelId, reasoningEffort: metadata.reasoningEffort })) } as never);
    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "messages", messages: [{ role: "user", content: "resume" }], metadata, resume: { streamId: STREAM_ID, after: 0 } }) });
    const frames = await readFrames(response);
    expect(frames.filter((frame) => frame.type === "stream_end")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ type: "stream_end", status: "error" });
  });

  it("turns a corrupt protocol-v1 record into one safe error terminal frame", async () => {
    const store = await createStore({ events: [{ protocol: "anvia.client.v1", event: streamEvent.event }] });
    vi.mocked(getStreamStore).mockReturnValue({ ...store, getMeta: vi.fn(async () => ({ userId: USER_ID, sessionId: SESSION_ID, modelId: metadata.modelId, reasoningEffort: metadata.reasoningEffort })) } as never);
    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "messages", messages: [{ role: "user", content: "resume" }], metadata, resume: { streamId: STREAM_ID, after: 0 } }) });
    const frames = await readFrames(response);
    expect(frames.filter((frame) => frame.type === "stream_end")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ type: "stream_end", status: "error" });
  });

  it("rejects a corrupt data-schema event without leaking its payload", async () => {
    const invalid = { ...streamEvent, event: { ...streamEvent.event, metadata: { sessionId: "not-a-uuid" } } };
    const store = await createStore({ events: [invalid] });
    vi.mocked(getStreamStore).mockReturnValue({ ...store, getMeta: vi.fn(async () => ({ userId: USER_ID, sessionId: SESSION_ID, modelId: metadata.modelId, reasoningEffort: metadata.reasoningEffort })) } as never);
    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "messages", messages: [{ role: "user", content: "resume" }], metadata, resume: { streamId: STREAM_ID, after: 0 } }) });
    const frames = await readFrames(response);
    expect(frames.filter((frame) => frame.type === "stream_end")).toHaveLength(1);
    expect(JSON.stringify(frames)).not.toContain("not-a-uuid");
  });

  it("never emits the removed raw approval or clarification event names", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "interaction_response",
        interactionId: "interaction-1",
        response: { type: "tool-approval", approved: true },
        metadata,
        resume: { streamId: STREAM_ID, after: 0 },
      }),
    });

    expect(await response.text()).not.toMatch(/tool_approval_request|clarification_request/);
  });
});
