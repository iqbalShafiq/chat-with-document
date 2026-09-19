import { describe, expect, it, vi } from "vitest";
import type { AgentStream, AgentStreamEvent } from "@anvia/core/agent";
import { parseMessage, type Message } from "@anvia/core/completion";
import {
  type AgentStreamEvent as NativeAgentStreamEvent,
} from "@anvia/core/agent";
import {
  parseAgentContinuation,
  parseAgentInteractionRequest,
  parseAgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type { ChatResumableEvent } from "./client-events.js";
import type { StartRunJob, ResumeRunJob } from "./run-queue.js";
import { CHAT_AGENT_ID } from "./run-recipe.js";
import {
  ActiveRunRegistry,
  createChatRunProcessor,
  type ChatRunWorkerDependencies,
} from "./run-worker.js";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const STREAM_ID = "stream-1";

const recipe = {
  version: 2 as const,
  agentId: CHAT_AGENT_ID,
  identity: { sessionId: SESSION_ID, userId: USER_ID, projectId: null },
  model: { id: "deepseek/deepseek-v4-flash-0731", reasoningEffort: "max" as const },
  memoryPolicy: {
    version: 1 as const,
    savePolicy: "turn" as const,
    staticContextTokens: 0,
    triggerAfterTokens: 700_000,
    retentionRecentTokens: 300_000,
    compactorMaxTokens: 4096,
    conflictRetries: 3,
  },
  staticContext: {
    version: 1 as const,
    instructions: { base: "Base", additional: [] },
    context: [],
    tools: [],
    model: {
      contextWindowTokens: 1_050_000,
      maxInputTokens: null,
      maxOutputTokens: null,
    },
    staticContextTokens: 0,
  },
  features: {
    webSearchEnabled: false,
    imageGenerationEnabled: false,
    deepResearchEnabled: false,
  },
  imageGenSettings: null,
  budgets: { maxTurns: 20, deepResearchMaxTurns: 8, deepResearchMaxSearches: 12, deepResearchMaxDurationMs: 360_000 },
  documents: { ids: [], catalog: [] },
  instructionFragments: [],
  contextDescriptors: [],
  activeContext: { images: [], snippet: null },
  capabilities: {
    modelAcceptsImage: false,
    webSearchAvailable: false,
    imageGenerationAvailable: false,
    deepResearchAvailable: false,
    profilingEnabled: false,
    context7Requested: false,
    imageModelCapabilities: [],
  },
  promptClientMessageId: "prompt-1",
  trace: { traceId: "trace-1" },
};

const prompt = parseMessage({
  role: "user",
  content: [{ type: "text", text: "hello" }],
  metadata: { clientMessageId: "prompt-1" },
});

const baseOutcome = {
  runId: "native-run-1",
  text: "",
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  messages: [],
};

const interactionRequest = parseAgentInteractionRequest({
  id: "interaction-1",
  type: "tool-approval",
  toolName: "web_search",
  toolCallId: "tool-call-1",
  internalCallId: "internal-call-1",
  input: { query: "Anvia" },
});

const continuation = parseAgentContinuation({
  version: 1,
  agentId: CHAT_AGENT_ID,
  sourceRunId: "native-run-1",
  interaction: interactionRequest,
  state: { cursor: 1 },
});

const response = parseAgentInteractionResponse({
  type: "tool-approval",
  approved: true,
});

function startJob(streamId = STREAM_ID): StartRunJob {
  return {
    kind: "start",
    streamId,
    sessionId: SESSION_ID,
    userId: USER_ID,
    recipe,
    prompt,
    createdAt: new Date().toISOString(),
  };
}

function resumeJob(streamId = "resume-stream-1"): ResumeRunJob {
  return {
    kind: "resume",
    streamId,
    sessionId: SESSION_ID,
    userId: USER_ID,
    recipe,
    continuation,
    response,
    sourceInteractionId: interactionRequest.id,
    createdAt: new Date().toISOString(),
  };
}

function responseEvent(runId = "native-run-1"): NativeAgentStreamEvent {
  return {
    ...baseOutcome,
    runId,
    type: "response",
    output: "done",
    text: "done",
  } as NativeAgentStreamEvent;
}

function blockedEvent(runId = "native-run-1"): NativeAgentStreamEvent {
  return {
    ...baseOutcome,
    runId,
    type: "blocked",
    stage: "output",
    reason: "policy",
  } as NativeAgentStreamEvent;
}

function interactionEvent(runId = "native-run-1"): NativeAgentStreamEvent {
  return {
    ...baseOutcome,
    runId,
    type: "interaction",
    interaction: interactionRequest,
    continuation,
  } as NativeAgentStreamEvent;
}

function errorEvent(error: unknown = new Error("provider secret should not leak")): NativeAgentStreamEvent {
  return {
    type: "error",
    error,
    usage: baseOutcome.usage,
  } as NativeAgentStreamEvent;
}

function toAsync<T>(values: readonly T[]): AsyncIterable<T> {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

function fakeStream(
  events: readonly NativeAgentStreamEvent[],
  onSteer?: (input: unknown) => { id: string; status: "queued" },
): AgentStream {
  const output = toAsync(events);
  return {
    events: output,
    [Symbol.asyncIterator]() {
      return output[Symbol.asyncIterator]();
    },
    textStream: toAsync([]),
    text: Promise.resolve(""),
    result: Promise.resolve(responseEvent() as never),
    steer: onSteer ?? (() => ({ id: "receipt-1", status: "queued" as const })),
    cancel: vi.fn(),
  } as AgentStream;
}

function createStreamStore() {
  const events: ChatResumableEvent[] = [];
  const statuses: string[] = [];
  let status: "running" | "completed" | "error" = "running";
  return {
    events,
    statuses,
    async status() {
      return { status, lastEventId: events.length };
    },
    async append(input: { event: ChatResumableEvent }) {
      events.push(input.event);
      return { streamId: STREAM_ID, eventId: events.length, event: input.event };
    },
    async close(input: { status: "completed" | "error" }) {
      status = input.status;
      statuses.push(input.status);
      return { status, lastEventId: events.length };
    },
  };
}

function createDependencies(
  stream: AgentStream,
  overrides: Partial<ChatRunWorkerDependencies> = {},
) {
  const store = createStreamStore();
  const streamCalls: unknown[] = [];
  const releases: string[] = [];
  const dependencies: ChatRunWorkerDependencies = {
    streamStore: store,
    reconstruct: async () => ({
      agent: {
        stream(input: unknown) {
          streamCalls.push(input);
          return stream;
        },
      },
      projectId: null,
      sessionId: SESSION_ID,
      userId: USER_ID,
      waitRegistry: { abortAll() {} },
    } as never),
    releaseActiveRun: async (_sessionId, streamId) => {
      releases.push(streamId);
    },
    isStopRequested: async () => false,
    touchOwnerWal: async () => undefined,
    touchRunCreated: async () => undefined,
    clearOwnerWal: async () => undefined,
    clearStopFlag: async () => undefined,
    sessionExists: async () => true,
    claimInteractionPolicy: async () => null,
    consumeInteractionPolicy: async () => undefined,
    releaseInteractionPolicy: async () => undefined,
    approvalRegistry: {
      async grantTool() {},
      async hasToolGrant() { return false; },
      async revokeToolGrant() {},
      async setToolOverride() {},
      async takeToolOverride() { return null; },
    },
    steeringStore: {
      async push() { return true; },
      async pop() { return null; },
      async requeue() {},
      async drain() { return 0; },
    },
    ...overrides,
  };
  return { dependencies, store, streamCalls, releases };
}

describe("Anvia v1 chat worker", () => {
  it("stops accepting work and cancels every active native run exactly once", async () => {
    const registry = new ActiveRunRegistry();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const cancel = vi.fn();
    const unregister = registry.register("stream-1", { cancel, done });
    registry.stopAccepting();
    await expect(Promise.resolve().then(() => registry.register("stream-2", { cancel, done }))).rejects.toThrow("shutting down");
    const stopping = registry.cancelAll("shutdown");
    expect(cancel).toHaveBeenCalledWith("shutdown");
    resolveDone();
    await stopping;
    expect(cancel).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("starts a native stream with prompt/session/trace and never uses a v0 request wrapper", async () => {
    const stream = fakeStream([responseEvent()]);
    const h = createDependencies(stream);
    await createChatRunProcessor(h.dependencies)(startJob());
    expect(h.streamCalls).toHaveLength(1);
    expect(h.streamCalls[0]).toMatchObject({
      prompt,
      session: { sessionId: SESSION_ID, userId: USER_ID, metadata: { streamId: STREAM_ID } },
      trace: { traceId: "trace-1", sessionId: SESSION_ID, userId: USER_ID },
      abortSignal: expect.any(AbortSignal),
    });
    expect(h.streamCalls[0]).not.toHaveProperty("continuation");
  });

  it("resumes with only the official continuation and response shape", async () => {
    const stream = fakeStream([responseEvent("native-run-1")]);
    const h = createDependencies(stream);
    await createChatRunProcessor(h.dependencies)(resumeJob());
    expect(h.streamCalls[0]).toMatchObject({
      continuation,
      response,
      trace: { traceId: "trace-1" },
      abortSignal: expect.any(AbortSignal),
    });
    expect(h.streamCalls[0]).not.toHaveProperty("prompt");
    expect(h.streamCalls[0]).not.toHaveProperty("session");
  });

  it("claims staged resume policy, applies it, and consumes only after native stream acceptance", async () => {
    const order: string[] = [];
    const stream = fakeStream([responseEvent()]);
    const policy = {
      state: "claimed" as const,
      interactionId: interactionRequest.id,
      userId: USER_ID,
      sessionId: SESSION_ID,
      toolName: interactionRequest.toolName,
      responseFingerprint: "a".repeat(64),
      claimToken: "claim-token-1",
      claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      grantScope: "session" as const,
      overrideArgs: { aspectRatio: "1:1" },
    };
    const h = createDependencies(stream, {
      claimInteractionPolicy: async (input) => {
        order.push("claim");
        expect(input).toMatchObject({
          interactionId: interactionRequest.id,
          userId: USER_ID,
          sessionId: SESSION_ID,
          toolName: interactionRequest.toolName,
          claimToken: expect.any(String),
        });
        return { ...policy, claimToken: input.claimToken };
      },
      approvalRegistry: {
        async grantTool() { order.push("grant"); },
        async hasToolGrant() { return false; },
        async revokeToolGrant() {},
        async setToolOverride() { throw new Error("global override must not be written"); },
        async takeToolOverride() { return null; },
      },
      consumeInteractionPolicy: async (input) => {
        order.push("consume");
        expect(input.claimToken).toEqual(expect.any(String));
      },
    });
    const baseReconstruct = h.dependencies.reconstruct!;
    h.dependencies.reconstruct = async (input) => {
      const localOverride = await input.grantHelpers?.takeToolOverride(interactionRequest.toolName);
      expect(localOverride).toEqual({ aspectRatio: "1:1" });
      return baseReconstruct(input);
    };
    await createChatRunProcessor(h.dependencies)(resumeJob());
    expect(order).toEqual(["claim", "grant", "consume"]);
  });

  it("releases a claimed resume policy when reconstruction fails before native execution", async () => {
    const released: string[] = [];
    const h = createDependencies(fakeStream([responseEvent()]), {
      claimInteractionPolicy: async (input) => ({
        state: "claimed" as const,
        interactionId: input.interactionId,
        userId: input.userId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        responseFingerprint: input.responseFingerprint,
        claimToken: input.claimToken,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        overrideArgs: { aspectRatio: "1:1" },
      }),
      reconstruct: async () => {
        throw new Error("reconstruction secret");
      },
      approvalRegistry: {
        async grantTool() {},
        async hasToolGrant() { return false; },
        async revokeToolGrant() {},
        async setToolOverride() { throw new Error("global override must not be written"); },
        async takeToolOverride() { throw new Error("override must remain run-local"); },
      },
      releaseInteractionPolicy: async ({ claimToken }) => {
        released.push(claimToken);
      },
    });
    await expect(createChatRunProcessor(h.dependencies)(resumeJob())).rejects.toThrow("Something went wrong");
    expect(released).toHaveLength(1);
  });

  it("never falls back to the legacy session/tool override registry", async () => {
    const legacyTake = vi.fn(async () => ({ unsafe: true }));
    const h = createDependencies(fakeStream([responseEvent()]), {
      approvalRegistry: {
        async grantTool() {},
        async hasToolGrant() { return false; },
        async revokeToolGrant() {},
        async setToolOverride() {},
        takeToolOverride: legacyTake,
      },
    });
    const baseReconstruct = h.dependencies.reconstruct!;
    h.dependencies.reconstruct = async (input) => {
      await expect(input.grantHelpers?.takeToolOverride("web_search")).resolves.toBeNull();
      return baseReconstruct(input);
    };

    await createChatRunProcessor(h.dependencies)(startJob());
    expect(legacyTake).not.toHaveBeenCalled();
  });

  it("does not create a provider stream when shutdown wins during reconstruction", async () => {
    const registry = new ActiveRunRegistry();
    let finishReconstruct!: () => void;
    let reconstructStarted!: () => void;
    const started = new Promise<void>((resolve) => { reconstructStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { finishReconstruct = resolve; });
    const stream = vi.fn(() => fakeStream([responseEvent()]));
    const h = createDependencies(fakeStream([responseEvent()]), {
      activeRuns: registry,
      reconstruct: async () => {
        reconstructStarted();
        await blocked;
        return {
          agent: { stream },
          projectId: null,
          sessionId: SESSION_ID,
          userId: USER_ID,
        } as never;
      },
    });

    const processing = createChatRunProcessor(h.dependencies)(startJob());
    await started;
    const stopping = registry.cancelAll("shutdown");
    finishReconstruct();

    await expect(processing).rejects.toMatchObject({ name: "ChatRunCancelledError" });
    await stopping;
    expect(stream).not.toHaveBeenCalled();
  });

  it("releases the run when a client stop wins during reconstruction", async () => {
    let stopRequested = false;
    let reconstructStarted!: () => void;
    const started = new Promise<void>((resolve) => { reconstructStarted = resolve; });
    const stream = vi.fn(() => fakeStream([responseEvent()]));
    const h = createDependencies(fakeStream([responseEvent()]), {
      isStopRequested: async () => stopRequested,
      reconstruct: async () => {
        reconstructStarted();
        stopRequested = true;
        await new Promise(() => undefined);
        return {
          agent: { stream },
          projectId: null,
          sessionId: SESSION_ID,
          userId: USER_ID,
        } as never;
      },
    });

    const processing = createChatRunProcessor(h.dependencies)(startJob());
    await started;
    await expect(processing).rejects.toMatchObject({ name: "ChatRunCancelledError" });
    expect(stream).not.toHaveBeenCalled();
    expect(h.releases).toContain(STREAM_ID);
  });

  it("does not open a provider stream when the session is deleted during reconstruction", async () => {
    let exists = true;
    const stream = vi.fn(() => fakeStream([responseEvent()]));
    const h = createDependencies(fakeStream([responseEvent()]), {
      sessionExists: async () => exists,
      reconstruct: async () => {
        exists = false;
        return {
          agent: { stream },
          projectId: null,
          sessionId: SESSION_ID,
          userId: USER_ID,
        } as never;
      },
    });

    await expect(createChatRunProcessor(h.dependencies)(startJob())).rejects.toMatchObject({
      name: "ChatRunCancelledError",
    });
    expect(stream).not.toHaveBeenCalled();
    expect(h.releases).toContain(STREAM_ID);
  });

  it("maps response, interaction, and blocked terminals to v3 events and storage statuses", async () => {
    const responseHarness = createDependencies(fakeStream([responseEvent()]));
    await createChatRunProcessor(responseHarness.dependencies)(startJob());
    expect(responseHarness.store.events.some((event) => event.event.type === "run_end" && event.event.status === "completed")).toBe(true);
    expect(responseHarness.store.statuses).toEqual(["completed"]);

    let persisted = false;
    const interactionHarness = createDependencies(fakeStream([interactionEvent()]), {
      persistInteraction: async () => {
        persisted = true;
      },
    });
    await createChatRunProcessor(interactionHarness.dependencies)(startJob());
    expect(persisted).toBe(true);
    const interactionIndex = interactionHarness.store.events.findIndex((event) => event.event.type === "interaction");
    expect(interactionIndex).toBeGreaterThanOrEqual(0);
    expect(interactionHarness.store.events[interactionIndex + 1]?.event).toMatchObject({ type: "run_end", status: "suspended" });
    expect(interactionHarness.store.statuses).toEqual(["completed"]);

    const blockedHarness = createDependencies(fakeStream([blockedEvent()]));
    await createChatRunProcessor(blockedHarness.dependencies)(startJob());
    expect(blockedHarness.store.events.some((event) => event.event.type === "run_end" && event.event.status === "blocked")).toBe(true);
    expect(blockedHarness.store.statuses).toEqual(["completed"]);
  });

  it("does not expose an interaction before durable persistence resolves", async () => {
    let resolvePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    const h = createDependencies(fakeStream([interactionEvent()]), {
      persistInteraction: async () => persistence,
    });
    const running = createChatRunProcessor(h.dependencies)(startJob());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.events.some((event) => event.event.type === "interaction")).toBe(false);
    resolvePersistence();
    await running;
  });

  it("turns interaction persistence failure into a safe error terminal without exposing the card", async () => {
    const h = createDependencies(fakeStream([interactionEvent()]), {
      persistInteraction: async () => {
        throw new Error("database continuation secret");
      },
    });
    await expect(createChatRunProcessor(h.dependencies)(startJob())).rejects.toThrow("Something went wrong");
    expect(h.store.events.some((event) => event.event.type === "interaction")).toBe(false);
    expect(h.store.events.some((event) => event.event.type === "run_end" && event.event.status === "error")).toBe(true);
    expect(h.store.statuses).toEqual(["error"]);
    expect(JSON.stringify(h.store.events)).not.toContain("database continuation secret");
  });

  it("uses native steering receipts and only acknowledges matching steering_applied", async () => {
    const applied: string[] = [];
    const steered: unknown[] = [];
    const stream = fakeStream([
      { type: "turn_start", turn: 1, prompt, history: [] } as NativeAgentStreamEvent,
      { type: "steering_applied", id: "receipt-1", turn: 1 } as NativeAgentStreamEvent,
      responseEvent(),
    ], (input) => {
      steered.push(input);
      return { id: "receipt-1", status: "queued" };
    });
    const h = createDependencies(stream, {
      steeringStore: {
        async push() { return true; },
        async pop() {
          return { clientMessageId: "queued-1", text: "follow up" };
        },
        async requeue() {},
        async drain() { return 0; },
      } as never,
      onSteeringApplied: async (message) => {
        applied.push(message.clientMessageId);
      },
    });
    await createChatRunProcessor(h.dependencies)(startJob());
    expect(steered[0]).toMatchObject({ prompt: expect.objectContaining({ role: "user" }) });
    expect(applied).toEqual(["queued-1"]);
  });

  it("forwards the non-terminal stream prefix before a later response is available", async () => {
    let releaseResponse!: () => void;
    const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const events = (async function* (): AsyncGenerator<NativeAgentStreamEvent> {
      yield { type: "run_start" } as unknown as NativeAgentStreamEvent;
      yield { type: "text_delta", delta: "partial" } as unknown as NativeAgentStreamEvent;
      await responseReady;
      yield responseEvent();
    })();
    const stream = {
      events,
      [Symbol.asyncIterator]() { return events[Symbol.asyncIterator](); },
      textStream: toAsync([]),
      text: Promise.resolve(""),
      result: Promise.resolve(responseEvent() as never),
      steer: () => ({ id: "receipt-1", status: "queued" as const }),
      cancel: vi.fn(),
    } as AgentStream;
    const h = createDependencies(stream);
    const running = createChatRunProcessor(h.dependencies)(startJob());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.events.some((event) => event.event.type === "text_delta")).toBe(true);
    releaseResponse();
    await running;
  });

  it("cancels native stream and aborts on a live stop signal without a fake failed pair", async () => {
    let stopped = false;
    const cancel = vi.fn();
    const stream = { ...fakeStream([responseEvent()]), cancel } as AgentStream;
    const h = createDependencies(stream, {
      isStopRequested: async () => stopped,
    });
    stopped = true;
    await expect(createChatRunProcessor(h.dependencies)(startJob())).rejects.toMatchObject({
      name: "ChatRunCancelledError",
      message: "The answer was stopped.",
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(h.streamCalls).toHaveLength(0);
    expect(h.store.events.some((event) => event.event.type === "run_end" && event.event.status === "error")).toBe(true);
    expect(h.store.events.some((event) => event.event.type === "error" && JSON.stringify(event).includes("provider secret"))).toBe(false);
  });

  it("cancels an already-owned native stream when the stop signal arrives", async () => {
    let releaseResponse!: () => void;
    const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let stopChecks = 0;
    const cancel = vi.fn(() => releaseResponse());
    const events = (async function* (): AsyncGenerator<NativeAgentStreamEvent> {
      yield { type: "text_delta", delta: "partial" } as unknown as NativeAgentStreamEvent;
      await responseReady;
      yield responseEvent();
    })();
    const stream = {
      events,
      [Symbol.asyncIterator]() { return events[Symbol.asyncIterator](); },
      textStream: toAsync([]),
      text: Promise.resolve(""),
      result: Promise.resolve(responseEvent() as never),
      steer: () => ({ id: "receipt-1", status: "queued" as const }),
      cancel,
    } as AgentStream;
    const h = createDependencies(stream, {
      isStopRequested: async () => stopChecks++ > 0,
    });
    await expect(createChatRunProcessor(h.dependencies)(startJob())).rejects.toMatchObject({
      name: "ChatRunCancelledError",
      message: "The answer was stopped.",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.streamCalls).toHaveLength(1);
  });

  it("retries one strict transient model failure before visible output and does not retry after visibility", async () => {
    const first = fakeStream([
      { type: "run_start" } as unknown as NativeAgentStreamEvent,
      { type: "generation_start" } as unknown as NativeAgentStreamEvent,
      errorEvent(new Error("The requested model 'deepseek/deepseek-v4-flash-0731' does not exist")),
    ]);
    const second = fakeStream([responseEvent()]);
    let calls = 0;
    const removeFailedPromptRow = vi.fn(async () => undefined);
    const h = createDependencies(first, {
      reconstruct: async () => ({
        agent: {
          stream(input: unknown) {
            h.streamCalls.push(input);
            calls += 1;
            return calls === 1 ? first : second;
          },
        },
        projectId: null,
        sessionId: SESSION_ID,
        userId: USER_ID,
        waitRegistry: { abortAll() {} },
      } as never),
      removeFailedPromptRow,
    });
    await createChatRunProcessor(h.dependencies)(startJob());
    expect(calls).toBe(2);
    expect(removeFailedPromptRow).toHaveBeenCalledOnce();
    expect(removeFailedPromptRow).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: USER_ID,
      clientMessageId: "prompt-1",
    });
    expect(h.store.events.filter((event) => event.event.type === "run_start")).toHaveLength(1);

    const visible = createDependencies(fakeStream([
      { type: "text_delta", delta: "visible" } as NativeAgentStreamEvent,
      errorEvent(new Error("The requested model 'deepseek/deepseek-v4-flash-0731' does not exist")),
    ]));
    await expect(createChatRunProcessor(visible.dependencies)(startJob())).rejects.toThrow();
    expect(visible.streamCalls).toHaveLength(1);
  });

  it("maps provider errors to safe client diagnostics and closes storage as error", async () => {
    const clearStopFlag = vi.fn(async () => undefined);
    const h = createDependencies(fakeStream([errorEvent(new Error("secret prompt and provider details"))]), {
      clearStopFlag,
    });
    await expect(createChatRunProcessor(h.dependencies)(startJob())).rejects.toThrow();
    expect(h.store.statuses).toEqual(["error"]);
    expect(h.releases).toEqual([STREAM_ID]);
    expect(clearStopFlag).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.store.events)).not.toContain("secret prompt");
    expect(JSON.stringify(h.store.events)).not.toContain("provider details");
  });
});
