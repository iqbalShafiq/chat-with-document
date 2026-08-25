import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { parseAgentContinuation, parseAgentInteractionRequest } from "@anvia/core/agent/interactions";

const f = vi.hoisted(() => ({ store: {} as Record<string, ReturnType<typeof vi.fn>>, resolve: vi.fn(), releaseRecipe: vi.fn(), acquire: vi.fn(), releaseRun: vi.fn(), enqueueStart: vi.fn(), enqueueResume: vi.fn(), interactionGet: vi.fn(), interactionClaim: vi.fn(), interactionRelease: vi.fn(), interactionConsume: vi.fn(), queueAdd: vi.fn(), strip: vi.fn((message: unknown) => message), touch: vi.fn(), title: vi.fn() }));
const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const STREAM_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const metadata = { sessionId: SESSION_ID, documentIds: [], modelId: "deepseek/deepseek-v4-flash-0731", reasoningEffort: "max", webSearchEnabled: false, imageGenerationEnabled: false, deepResearchEnabled: false, imageGenSettings: null };
const recipe = { model: { id: metadata.modelId, reasoningEffort: metadata.reasoningEffort }, documents: { ids: [] }, features: { webSearchEnabled: false, imageGenerationEnabled: false, deepResearchEnabled: false }, imageGenSettings: null };
const interaction = { id: "interaction-1", userId: USER_ID, sessionId: SESSION_ID, state: "pending", fingerprint: "f".repeat(64), recipe, continuation: { interaction: { id: "interaction-1", type: "tool-approval", toolName: "web_search" } }, request: { id: "interaction-1", type: "tool-approval", toolName: "web_search" } };

vi.mock("@anvia/server", () => ({ resumeClientStreamResponse: vi.fn(() => new Response("stream", { status: 200 })) }));
vi.mock("../auth/middleware.js", () => ({ requireUser: async (c: { set: Function }, next: Function) => { c.set("user", { id: USER_ID }); await next(); } }));
vi.mock("../../lib/resumable-stream-store.js", () => ({ getStreamStore: vi.fn(() => f.store) }));
vi.mock("./run-queue.js", () => ({ ACTIVE_RUN_KEY: (id: string) => `rs-active:${id}`, tryAcquireActiveRun: f.acquire, releaseActiveRun: f.releaseRun, enqueueChatRun: f.enqueueStart, enqueueChatResume: f.enqueueResume, ChatRunReconciliationError: class ChatRunReconciliationError extends Error {} }));
vi.mock("./build-run-input.js", () => ({ resolveChatAgentRecipe: f.resolve, imageGenerationConfig: () => null, webSearchConfig: () => null }));
vi.mock("./run-recipe.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./run-recipe.js")>()), releaseChatAgentRecipeClaim: f.releaseRecipe }));
vi.mock("./interaction-store.js", () => ({ getInteractionStore: () => ({ get: f.interactionGet, claim: f.interactionClaim, release: f.interactionRelease, consume: f.interactionConsume }), InteractionStoreError: class InteractionStoreError extends Error { constructor(message: string, public code: string) { super(message); } }, InteractionOwnershipError: class extends Error {}, InteractionClaimedError: class extends Error {}, InteractionExpiredError: class extends Error {}, InteractionReplayedError: class extends Error {} }));
vi.mock("./interaction-policy-store.js", () => ({ getInteractionPolicyStore: () => ({ stage: vi.fn() }), interactionResponseFingerprint: () => "a".repeat(64), InteractionPolicyStoreError: class extends Error {}, InteractionPolicyOwnershipError: class extends Error {}, InteractionPolicyExpiredError: class extends Error {}, InteractionPolicyReplayError: class extends Error {}, InteractionPolicyConflictError: class extends Error {}, InteractionPolicyUnavailableError: class extends Error {} }));
vi.mock("./strip-user-attachments.js", () => ({ stripUserAttachments: f.strip }));
vi.mock("./chat-session.js", () => ({ touchChatSession: f.touch, setChatSessionTitleIfEmpty: f.title, ensureChatSession: vi.fn(), getOrCreateEmptyChatSession: vi.fn(), normalizeSessionTitle: vi.fn(), ProjectMembershipError: class extends Error {}, ChatSessionNotFoundError: class extends Error {}, renameChatSession: vi.fn() }));

import { chatRouter } from "./router.js";
import { ChatRunReconciliationError } from "./run-queue.js";
import { InteractionOwnershipError } from "./interaction-store.js";
const app = new Hono().route("/api/chat", chatRouter);
const messageBody = () => ({ type: "messages", messages: [{ role: "user", content: "hello" }], metadata });
const interactionBody = (id = "interaction-1") => ({ type: "interaction_response", interactionId: id, response: { type: "tool-approval", approved: true }, metadata });
const questionRequest = parseAgentInteractionRequest({
  id: "question-1",
  type: "tool-question",
  toolName: "deep_research",
  toolCallId: "tool-call-question",
  internalCallId: "internal-question",
  questions: [{ id: "scope", text: "Which scope?", allowCustom: true }],
});
const questionInteraction = {
  ...interaction,
  id: "question-1",
  continuation: { interaction: questionRequest },
  request: questionRequest,
};
const questionBody = () => ({
  type: "interaction_response",
  interactionId: "question-1",
  response: { type: "tool-question", answers: [{ questionId: "scope", value: "all documents" }] },
  metadata,
});

const fullRecipe = {
  version: 2 as const,
  agentId: "chat-agent" as const,
  identity: { sessionId: SESSION_ID, userId: USER_ID, projectId: null },
  model: { id: metadata.modelId, reasoningEffort: metadata.reasoningEffort },
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
  features: { webSearchEnabled: false, imageGenerationEnabled: false, deepResearchEnabled: false },
  imageGenSettings: null,
  budgets: { maxTurns: 20, deepResearchMaxTurns: 8, deepResearchMaxSearches: 12, deepResearchMaxDurationMs: 360_000 },
  documents: { ids: [], catalog: [] },
  instructionFragments: [],
  contextDescriptors: [],
  activeContext: { images: [], snippet: null },
  capabilities: { modelAcceptsImage: false, webSearchAvailable: false, imageGenerationAvailable: false, deepResearchAvailable: false, profilingEnabled: false, context7Requested: false, imageModelCapabilities: [] },
  promptClientMessageId: null,
  trace: { traceId: "trace-1" },
};
const fullQuestionInteraction = {
  ...questionInteraction,
  fingerprint: "f".repeat(64),
  recipe: fullRecipe,
  continuation: parseAgentContinuation({
    version: 1,
    agentId: "chat-agent",
    sourceRunId: "run-question-1",
    interaction: questionRequest,
    state: { cursor: 1 },
  }),
};

async function useActualResumeProtocol(): Promise<void> {
  const actual = await vi.importActual<typeof import("./run-queue.js")>("./run-queue.js");
  f.enqueueResume.mockImplementation((id, data, options) => actual.enqueueChatResume(id, data, {
    ...options,
    queueOverride: { add: f.queueAdd },
    token: "claim-token-1",
  }));
}

describe("chat route side-effect state machines", () => {
  beforeEach(() => { vi.clearAllMocks(); f.store = { getMeta: vi.fn(async () => ({ userId: USER_ID, sessionId: SESSION_ID, modelId: metadata.modelId, reasoningEffort: metadata.reasoningEffort })), status: vi.fn(async () => ({ status: "running", lastEventId: 0 })), openWithMeta: vi.fn(), close: vi.fn().mockResolvedValue(undefined), setStopFlag: vi.fn() }; f.resolve.mockResolvedValue(recipe); f.acquire.mockResolvedValue(true); f.enqueueStart.mockResolvedValue({ accepted: true }); f.enqueueResume.mockResolvedValue({}); f.interactionGet.mockResolvedValue(interaction); f.interactionClaim.mockResolvedValue({ token: "claim-token-1" }); f.interactionRelease.mockResolvedValue(undefined); f.interactionConsume.mockResolvedValue({ state: "consumed" }); f.queueAdd.mockResolvedValue(undefined); f.releaseRecipe.mockResolvedValue(undefined); f.releaseRun.mockResolvedValue(undefined); f.touch.mockResolvedValue(undefined); f.title.mockResolvedValue(undefined); });
  it("fresh valid request resolves, opens, enqueues once, and subscribes", async () => { const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(messageBody()) }); expect(response.status).toBe(200); expect(f.resolve).toHaveBeenCalledOnce(); expect(f.acquire).toHaveBeenCalledOnce(); expect(f.store.openWithMeta).toHaveBeenCalledOnce(); expect(f.enqueueStart).toHaveBeenCalledOnce(); expect(f.releaseRecipe).not.toHaveBeenCalled(); });
  it.each(["resolver", "lease", "open", "add"])("rolls back each pre-accept boundary: %s", async (boundary) => { if (boundary === "resolver") f.resolve.mockRejectedValueOnce(new Error("resolve")); if (boundary === "lease") f.acquire.mockResolvedValueOnce(false); if (boundary === "open") f.store.openWithMeta.mockRejectedValueOnce(new Error("open")); if (boundary === "add") f.enqueueStart.mockRejectedValueOnce(new Error("add")); const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(messageBody()) }); expect([404, 409, 503]).toContain(response.status); expect(f.enqueueStart.mock.calls.length).toBeLessThanOrEqual(1); expect(f.releaseRecipe).toHaveBeenCalledTimes(boundary === "resolver" || boundary === "add" ? 0 : 1); });
  it("preserves stream and lease after post-accept reconciliation", async () => { f.enqueueStart.mockRejectedValueOnce(new ChatRunReconciliationError("chat:stream-1")); const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(messageBody()) }); expect(response.status).toBe(200); expect(f.store.close).not.toHaveBeenCalled(); expect(f.releaseRun).not.toHaveBeenCalled(); expect(f.releaseRecipe).not.toHaveBeenCalled(); });
  it("resumes a valid approval interaction and never invokes fresh resolver", async () => { const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(interactionBody()) }); expect(response.status).toBe(200); expect(f.interactionGet).toHaveBeenCalledOnce(); expect(f.enqueueResume).toHaveBeenCalledOnce(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.store.openWithMeta).toHaveBeenCalledOnce(); expect(f.acquire).toHaveBeenCalledOnce(); });
  it("accepts the official native question response before enqueueing", async () => { f.interactionGet.mockResolvedValueOnce(questionInteraction); const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(questionBody()) }); expect(response.status).toBe(200); expect(f.enqueueResume).toHaveBeenCalledOnce(); expect(f.acquire).toHaveBeenCalledOnce(); });
  it("rejects a response-type mismatch before acquiring a lease or claiming work", async () => { const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...interactionBody(), response: { type: "tool-question", answers: [{ questionId: "scope", value: "wrong" }] } }) }); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "INTERACTION_RESPONSE_INVALID" }); expect(f.acquire).not.toHaveBeenCalled(); expect(f.store.openWithMeta).not.toHaveBeenCalled(); expect(f.enqueueResume).not.toHaveBeenCalled(); });
  it.each(["claimed", "expired", "consumed"])("short-circuits %s interaction before open/lease", async (state) => { f.interactionGet.mockResolvedValueOnce({ ...interaction, state }); await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(interactionBody()) }); expect(f.acquire).not.toHaveBeenCalled(); expect(f.store.openWithMeta).not.toHaveBeenCalled(); expect(f.enqueueResume).not.toHaveBeenCalled(); });
  it("masks a wrong-owner interaction as not found before any side effect", async () => { f.interactionGet.mockRejectedValueOnce(new InteractionOwnershipError("interaction-1")); const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(interactionBody()) }); expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: "INTERACTION_NOT_FOUND" }); expect(f.acquire).not.toHaveBeenCalled(); });
  it("double-click replay is stable and has no second stream or lease", async () => { f.interactionGet.mockResolvedValue({ ...interaction, state: "consumed" }); const responses = await Promise.all([app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(interactionBody()) }), app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(interactionBody()) })]); expect(responses.map((response) => response.status)).toEqual([409, 409]); expect((await responses[0].json()).code).toBe("INTERACTION_REPLAYED"); expect(f.enqueueResume).not.toHaveBeenCalled(); expect(f.acquire).not.toHaveBeenCalled(); expect(f.store.openWithMeta).not.toHaveBeenCalled(); });
  it("cursor wrong owner, stale, and valid paths never claim or enqueue", async () => { f.store.getMeta.mockResolvedValueOnce(null); const wrong = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...messageBody(), resume: { streamId: STREAM_ID, after: 0 } }) }); expect(wrong.status).toBe(404); f.store.getMeta.mockResolvedValue({ userId: USER_ID, sessionId: SESSION_ID }); f.store.status.mockResolvedValueOnce({ status: "running", lastEventId: 1 }); const stale = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...messageBody(), resume: { streamId: STREAM_ID, after: 2 } }) }); expect(stale.status).toBe(409); f.store.status.mockResolvedValueOnce({ status: "running", lastEventId: 1 }); const valid = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...messageBody(), resume: { streamId: STREAM_ID, after: 1 } }) }); expect(valid.status).toBe(200); expect(f.enqueueStart).not.toHaveBeenCalled(); expect(f.enqueueResume).not.toHaveBeenCalled(); expect(f.interactionClaim).not.toHaveBeenCalled(); expect(f.queueAdd).not.toHaveBeenCalled(); });

  it("runs native question claim, queue add, and consume in route order", async () => {
    await useActualResumeProtocol();
    const order: string[] = [];
    f.interactionGet.mockResolvedValue(fullQuestionInteraction);
    f.interactionClaim.mockImplementation(async () => { order.push("claim"); return { token: "claim-token-1" }; });
    f.queueAdd.mockImplementation(async () => { order.push("add"); });
    f.interactionConsume.mockImplementation(async () => { order.push("consume"); return { state: "consumed" }; });

    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(questionBody()) });
    expect(response.status).toBe(200);
    expect(order).toEqual(["claim", "add", "consume"]);
  });

  it("releases the real claim and rolls back route resources when queue add fails", async () => {
    await useActualResumeProtocol();
    const order: string[] = [];
    f.interactionGet.mockResolvedValue(fullQuestionInteraction);
    f.interactionClaim.mockImplementation(async () => { order.push("claim"); return { token: "claim-token-1" }; });
    f.queueAdd.mockImplementation(async () => { order.push("add"); throw new Error("queue unavailable"); });
    f.interactionRelease.mockImplementation(async () => { order.push("release"); });

    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(questionBody()) });
    expect(response.status).toBe(500);
    expect(order).toEqual(["claim", "add", "release"]);
    expect(f.store.close).toHaveBeenCalledOnce();
    expect(f.releaseRun).toHaveBeenCalledOnce();
  });

  it("keeps accepted route resources when consume needs reconciliation", async () => {
    await useActualResumeProtocol();
    f.interactionGet.mockResolvedValue(fullQuestionInteraction);
    f.interactionConsume.mockRejectedValueOnce(new Error("consume unavailable"));

    const response = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(questionBody()) });
    expect(response.status).toBe(200);
    expect(f.interactionClaim).toHaveBeenCalledOnce();
    expect(f.queueAdd).toHaveBeenCalledOnce();
    expect(f.interactionConsume).toHaveBeenCalledOnce();
    expect(f.interactionRelease).not.toHaveBeenCalled();
    expect(f.store.close).not.toHaveBeenCalled();
    expect(f.releaseRun).not.toHaveBeenCalled();
  });

  it("turns a real first transition into a replay before a second lease or queue add", async () => {
    await useActualResumeProtocol();
    let state = "pending";
    f.interactionGet.mockImplementation(async () => ({ ...fullQuestionInteraction, state }));
    f.interactionClaim.mockImplementation(async () => { state = "claimed"; return { token: "claim-token-1" }; });
    f.interactionConsume.mockImplementation(async () => { state = "consumed"; return { ...fullQuestionInteraction, state }; });

    const first = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(questionBody()) });
    const second = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(questionBody()) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.queueAdd).toHaveBeenCalledOnce();
  });
});
