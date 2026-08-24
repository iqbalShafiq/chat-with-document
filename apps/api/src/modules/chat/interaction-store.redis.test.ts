import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import {
  createInteractionStore,
  interactionKey,
  interactionTombstoneKey,
  InteractionClaimedError,
  InteractionCorruptError,
  InteractionExpiredError,
  InteractionConflictError,
  type InteractionRedis,
} from "./interaction-store.js";
import { parseAgentContinuation, parseAgentInteractionRequest, parseAgentInteractionResponse } from "@anvia/core/agent/interactions";
import { CHAT_AGENT_ID, parseChatAgentRecipe } from "./run-recipe.js";

const userId = "redis-integration-user";
const sessionId = "redis-integration-session";
const recipe = parseChatAgentRecipe({
  version: 2,
  agentId: CHAT_AGENT_ID,
  identity: { sessionId, userId, projectId: null },
  model: { id: "openai/gpt-5.6-luna", reasoningEffort: "medium" },
  memoryPolicy: {
    version: 1,
    savePolicy: "turn",
    staticContextTokens: 0,
    triggerAfterTokens: 700_000,
    retentionRecentTokens: 300_000,
    compactorMaxTokens: 4096,
    conflictRetries: 3,
  },
  staticContext: {
    version: 1,
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
  budgets: { maxTurns: 20, deepResearchMaxTurns: 8, deepResearchMaxSearches: 12 },
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
  promptClientMessageId: null,
  trace: { traceId: "redis-integration-trace" },
});

const request = parseAgentInteractionRequest({
  id: "placeholder",
  type: "tool-approval",
  toolName: "web_search",
  toolCallId: "redis-tool-call",
  internalCallId: "redis-internal-call",
  input: { query: "redis integration" },
});
const response = parseAgentInteractionResponse({ type: "tool-approval", approved: true });

let redis: Redis;
const ids = new Set<string>();

function makeInput() {
  const id = `redis-${randomUUID()}`;
  ids.add(id);
  const interaction = parseAgentInteractionRequest({ ...request, id });
  const continuation = parseAgentContinuation({
    version: 1,
    agentId: CHAT_AGENT_ID,
    sourceRunId: `run-${id}`,
    interaction,
    state: { cursor: 1 },
  });
  return {
    id,
    request: interaction,
    continuation,
    sourceRunId: continuation.sourceRunId,
    sourceStreamId: `source-${id}`,
    ownership: { userId, sessionId },
    recipe,
  };
}

function store() {
  return createInteractionStore(redis as unknown as InteractionRedis);
}

describe("InteractionStore production Redis Lua integration", () => {
  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:16379");
    try {
      await redis.ping();
    } catch (error) {
      throw new Error(`Redis integration infrastructure blocker at 127.0.0.1:16379: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  afterAll(async () => {
    if (redis) {
      for (const id of ids) await redis.del(interactionKey(id), interactionTombstoneKey(id));
      await redis.quit();
    }
  });

  it("executes production Lua for put, claim, consume, and idempotent reconciliation", async () => {
    const input = makeInput();
    const interaction = store();
    expect(interactionKey(input.id)).not.toContain(input.id);
    expect(interactionKey(input.id).match(/\{([^}]+)\}/)?.[1]).toBe(
      interactionTombstoneKey(input.id).match(/\{([^}]+)\}/)?.[1],
    );
    const pending = await interaction.put({ ...input, ttlSeconds: 30 });
    expect(pending.state).toBe("pending");
    expect(await redis.pttl(interactionKey(input.id))).toBeGreaterThan(30_000);
    expect((await redis.hget(interactionKey(input.id), "schemaVersion"))).toBe("interaction-v1");

    const claim = await interaction.claim(input.id, {
      userId,
      sessionId,
      resumeStreamId: "resume-stream-a",
      response,
    });
    expect(claim.record).toMatchObject({ state: "claimed", resumeStreamId: "resume-stream-a" });
    const consumed = await interaction.consume({
      id: input.id,
      userId,
      sessionId,
      token: claim.token,
      resumeStreamId: "resume-stream-a",
      jobId: `chat-resume:${input.id}`,
      response,
    });
    expect(consumed.state).toBe("consumed");
    await expect(interaction.consume({
      id: input.id,
      userId,
      sessionId,
      resumeStreamId: "resume-stream-a",
      jobId: `chat-resume:${input.id}`,
      response,
    })).resolves.toMatchObject({ state: "consumed" });
    await expect(interaction.consume({
      id: input.id,
      userId,
      sessionId,
      resumeStreamId: "resume-stream-b",
      jobId: `chat-resume:${input.id}`,
      response,
    })).rejects.toBeInstanceOf(InteractionConflictError);
    await expect(redis.hgetall(interactionTombstoneKey(input.id))).resolves.toMatchObject({
      state: "consumed",
      jobId: `chat-resume:${input.id}`,
      resumeStreamId: "resume-stream-a",
    });
    await expect(redis.hgetall(interactionKey(input.id))).resolves.toMatchObject({
      schemaVersion: "interaction-v1",
      state: "consumed",
      jobId: `chat-resume:${input.id}`,
      resumeStreamId: "resume-stream-a",
    });
  });

  it("executes atomic concurrent claims and lease reclaim in production Redis", async () => {
    const input = makeInput();
    const first = store();
    await first.put({ ...input, ttlSeconds: 30 });
    const claims = await Promise.allSettled([
      first.claim(input.id, { userId, sessionId, resumeStreamId: "resume-a", response }),
      store().claim(input.id, { userId, sessionId, resumeStreamId: "resume-b", response }),
    ]);
    expect(claims.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((value) => value.status === "rejected" && value.reason instanceof InteractionClaimedError)).toHaveLength(1);

    const winningClaim = claims.find((value) => value.status === "fulfilled");
    if (!winningClaim || winningClaim.status !== "fulfilled") throw new Error("expected one winning claim");
    const [seconds, microseconds] = await redis.time();
    const redisNowMs = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
    await redis.hset(interactionKey(input.id), "claimExpiresAt", String(redisNowMs - 1));
    const boundResumeStreamId = winningClaim.value.record.resumeStreamId;
    expect(boundResumeStreamId).toMatch(/^resume-[ab]$/);

    const reclaimed = await store().claim(input.id, {
      userId,
      sessionId,
      resumeStreamId: boundResumeStreamId!,
      response,
    });
    expect(reclaimed.token).not.toBe(winningClaim.value.token);
    expect(reclaimed.record).toMatchObject({ state: "claimed", resumeStreamId: boundResumeStreamId });
    const consumed = await store().consume({
      id: input.id,
      userId,
      sessionId,
      token: reclaimed.token,
      resumeStreamId: boundResumeStreamId!,
      jobId: `chat-resume:${input.id}`,
      response,
    });
    expect(consumed.state).toBe("consumed");
  });

  it("marks logical expiry durably and rejects duplicate persistence", async () => {
    const input = makeInput();
    const interaction = store();
    await interaction.put({ ...input, ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(interaction.get(input.id)).resolves.toMatchObject({ state: "expired" });
    await expect(interaction.put({ ...input, ttlSeconds: 1 })).rejects.toBeInstanceOf(InteractionExpiredError);
  });

  it("rejects a production Redis hash with unknown fields as corrupt", async () => {
    const input = makeInput();
    const interaction = store();
    await interaction.put({ ...input, ttlSeconds: 30 });
    await redis.hset(interactionKey(input.id), "debug", "must-not-be-read");
    await expect(interaction.get(input.id)).rejects.toBeInstanceOf(InteractionCorruptError);
  });

  it("rejects state-incompatible response and claim fields in production Redis", async () => {
    const pending = makeInput();
    const pendingStore = store();
    await pendingStore.put({ ...pending, ttlSeconds: 30 });
    await redis.hset(
      interactionKey(pending.id),
      "responseFingerprint", "a".repeat(64),
      "resumeStreamId", "resume-stream-for-pending",
    );
    await expect(pendingStore.get(pending.id)).rejects.toBeInstanceOf(InteractionCorruptError);

    const expired = makeInput();
    const expiredStore = store();
    await expiredStore.put({ ...expired, ttlSeconds: 30 });
    await redis.hset(
      interactionKey(expired.id),
      "state", "expired",
      "responseFingerprint", "b".repeat(64),
      "resumeStreamId", "resume-stream-for-expired",
    );
    await expect(expiredStore.get(expired.id)).rejects.toBeInstanceOf(InteractionCorruptError);

    const consumed = makeInput();
    const consumedStore = store();
    await consumedStore.put({ ...consumed, ttlSeconds: 30 });
    const claim = await consumedStore.claim(consumed.id, {
      userId,
      sessionId,
      resumeStreamId: "resume-stream-consumed",
      response,
    });
    await consumedStore.consume({
      id: consumed.id,
      userId,
      sessionId,
      token: claim.token,
      resumeStreamId: "resume-stream-consumed",
      jobId: `chat-resume:${consumed.id}`,
      response,
    });
    await redis.hset(interactionKey(consumed.id), "ownerToken", "stale-claim");
    await expect(consumedStore.get(consumed.id)).rejects.toBeInstanceOf(InteractionCorruptError);
  });
});
