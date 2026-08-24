import { describe, expect, it, vi } from "vitest";
import {
  parseAgentInteractionRequest,
  parseAgentInteractionResponse,
  parseAgentContinuation,
} from "@anvia/core/agent/interactions";
import {
  createInteractionPersistenceCallback,
  createInteractionStore,
  interactionKey,
  interactionTombstoneKey,
  InteractionOwnershipError,
  InteractionStateError,
  InteractionTypeError,
  INTERACTION_CLAIMED_RETENTION_SECONDS,
  INTERACTION_CONSUMED_RETENTION_SECONDS,
  INTERACTION_EXPIRED_RETENTION_SECONDS,
  INTERACTION_PENDING_RETENTION_SECONDS,
  INTERACTION_TOMBSTONE_RETENTION_SECONDS,
  type InteractionRedis,
} from "./interaction-store.js";
import { CHAT_AGENT_ID, parseChatAgentRecipe } from "./run-recipe.js";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const STREAM_ID = "stream-1";

const recipe = parseChatAgentRecipe({
  version: 1,
  agentId: CHAT_AGENT_ID,
  identity: { sessionId: SESSION_ID, userId: USER_ID, projectId: null },
  model: { id: "openai/gpt-5.6-luna", reasoningEffort: "medium" },
  features: {
    webSearchEnabled: false,
    imageGenerationEnabled: false,
    deepResearchEnabled: false,
  },
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
  trace: { traceId: "trace-1" },
});

const request = parseAgentInteractionRequest({
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
  sourceRunId: "run-1",
  interaction: request,
  state: { cursor: 1 },
});

const response = parseAgentInteractionResponse({
  type: "tool-approval",
  approved: true,
});

type StoredHash = Record<string, string>;

/** A deterministic Redis fake that executes the store's tagged Lua commands. */
function createFakeRedis() {
  const hashes = new Map<string, StoredHash>();
  const physicalExpiresAt = new Map<string, number>();
  let serverNow = Date.now();
  const evalCalls: Array<{ script: string; key: string; args: string[] }> = [];
  const timestamp = (value: string) => /^\d+$/.test(value) ? Number(value) : Date.parse(value);

  const expireIfNeeded = (key: string) => {
    const expiry = physicalExpiresAt.get(key);
    if (expiry !== undefined && expiry <= serverNow) {
      hashes.delete(key);
      physicalExpiresAt.delete(key);
    }
  };
  const redis: InteractionRedis & { __hashes: typeof hashes; __physicalExpiresAt: typeof physicalExpiresAt; __evalCalls: typeof evalCalls; __setNow(value: number): void } = {
    eval: vi.fn(async (script: string, keyCount: number, key: string, ...rawArgs: string[]) => {
      const keys = [key, ...rawArgs.splice(0, keyCount - 1)];
      const args = rawArgs;
      const tombstoneKey = keys[1]!;
      evalCalls.push({ script, key, args });
      for (const redisKey of keys) expireIfNeeded(redisKey);
      const now = serverNow;
      if (script.includes("interaction-store:put")) {
        if (hashes.has(key)) return hashes.get(key)?.fingerprint === args[9] ? "same" : "exists";
        if (hashes.has(tombstoneKey)) return "replayed";
        const [id, userId, sessionId, sourceStreamId, sourceRunId, requestJson, continuationJson, recipeJson, ttl, fingerprint] = args;
        const fields: StoredHash = {
          schemaVersion: "interaction-v1",
          id: id!,
          userId: userId!,
          sessionId: sessionId!,
          sourceStreamId: sourceStreamId!,
          sourceRunId: sourceRunId!,
          request: requestJson!,
          continuation: continuationJson!,
          recipe: recipeJson!,
          state: "pending",
          createdAt: String(now),
          updatedAt: String(now),
          expiresAt: String(now + Number(ttl) * 1_000),
          fingerprint: fingerprint!,
        };
        hashes.set(key, fields);
        hashes.set(tombstoneKey, { schemaVersion: "interaction-v1", id: id!, userId: userId!, sessionId: sessionId!, fingerprint: fingerprint!, state: "pending", expiresAt: fields.expiresAt! });
        physicalExpiresAt.set(key, now + Number(ttl) * 1_000 + INTERACTION_PENDING_RETENTION_SECONDS * 1_000);
        physicalExpiresAt.set(tombstoneKey, now + 30 * 24 * 60 * 60 * 1_000);
        return "stored";
      }
      const record = hashes.get(key);
      if (!record) return "missing";
      if (script.includes("interaction-store:expire")) {
        if (record.state !== "consumed" && timestamp(record.expiresAt) <= now) {
          record.state = "expired";
          delete record.ownerToken;
          delete record.claimedAt;
          delete record.claimExpiresAt;
          delete record.responseFingerprint;
          delete record.resumeStreamId;
          record.updatedAt = new Date(now).toISOString();
          hashes.get(tombstoneKey)!.state = "expired";
          delete hashes.get(tombstoneKey)!.jobId;
          delete hashes.get(tombstoneKey)!.resumeStreamId;
          physicalExpiresAt.set(key, Math.max(now, timestamp(record.expiresAt)) + INTERACTION_EXPIRED_RETENTION_SECONDS * 1_000);
          return "expired";
        }
        return record.state;
      }
      if (script.includes("interaction-store:claim")) {
        const [userId, sessionId, token, fingerprint, responseFp, resumeStreamId] = args;
        if (record.userId !== userId || record.sessionId !== sessionId) return "owner";
        if (timestamp(record.expiresAt) <= now && record.state !== "consumed") {
          record.state = "expired";
          delete record.responseFingerprint;
          delete record.resumeStreamId;
          hashes.get(tombstoneKey)!.state = "expired";
          delete hashes.get(tombstoneKey)!.jobId;
          delete hashes.get(tombstoneKey)!.resumeStreamId;
          physicalExpiresAt.set(key, Math.max(now, timestamp(record.expiresAt)) + INTERACTION_EXPIRED_RETENTION_SECONDS * 1_000);
          return "expired";
        }
        if (record.state !== "pending") {
          if (record.state === "claimed" && Number(record.claimExpiresAt) <= now) {
            if (record.ownerToken === token) return "stale-claim";
            if (record.responseFingerprint !== responseFp || record.resumeStreamId !== resumeStreamId) return "claim-mismatch";
            record.ownerToken = token;
            record.claimedAt = String(now);
            record.claimExpiresAt = String(now + 120_000);
            record.responseFingerprint = responseFp;
            record.resumeStreamId = resumeStreamId;
            record.updatedAt = record.claimedAt;
            delete hashes.get(tombstoneKey)!.jobId;
            hashes.get(tombstoneKey)!.state = "claimed";
            hashes.get(tombstoneKey)!.resumeStreamId = resumeStreamId!;
            physicalExpiresAt.set(key, Math.max(now, timestamp(record.expiresAt)) + INTERACTION_CLAIMED_RETENTION_SECONDS * 1_000);
            return "reclaimed";
          }
          if (record.state === "claimed" && record.ownerToken === token) {
            if (record.responseFingerprint !== responseFp || record.resumeStreamId !== resumeStreamId) return "claim-mismatch";
            return "same-claim";
          }
          return record.state === "claimed" ? "already-claimed" : record.state;
        }
        if (record.fingerprint !== fingerprint) return "fingerprint";
        record.state = "claimed";
        record.ownerToken = token;
        record.claimedAt = String(now);
        record.claimExpiresAt = String(now + 120_000);
        record.responseFingerprint = responseFp;
        record.resumeStreamId = resumeStreamId;
        record.updatedAt = record.claimedAt;
        delete hashes.get(tombstoneKey)!.jobId;
        hashes.get(tombstoneKey)!.state = "claimed";
        hashes.get(tombstoneKey)!.resumeStreamId = resumeStreamId!;
        physicalExpiresAt.set(key, Math.max(now, timestamp(record.expiresAt)) + INTERACTION_CLAIMED_RETENTION_SECONDS * 1_000);
        return "claimed";
      }
      if (script.includes("interaction-store:release")) {
        const [userId, sessionId, token] = args;
        if (record.userId !== userId || record.sessionId !== sessionId) return "owner";
        if (record.state !== "claimed" || record.ownerToken !== token) return record.state;
        record.state = "pending";
        delete record.ownerToken;
        delete record.claimedAt;
        delete record.claimExpiresAt;
        delete record.responseFingerprint;
        delete record.resumeStreamId;
        record.updatedAt = String(now);
        hashes.get(tombstoneKey)!.state = "pending";
        delete hashes.get(tombstoneKey)!.jobId;
        delete hashes.get(tombstoneKey)!.resumeStreamId;
        physicalExpiresAt.set(key, Math.max(now, timestamp(record.expiresAt)) + INTERACTION_PENDING_RETENTION_SECONDS * 1_000);
        return "released";
      }
      if (script.includes("interaction-store:consume")) {
        const [userId, sessionId, token, responseJson, fingerprint, responseFp, jobId, resumeStreamId] = args;
        if (record.userId !== userId || record.sessionId !== sessionId) return "owner";
        if (record.state === "consumed") {
          return record.jobId === jobId && record.fingerprint === fingerprint && record.response === responseJson && record.responseFingerprint === responseFp && record.resumeStreamId === resumeStreamId
            ? "already-consumed"
            : "replay-conflict";
        }
        if (record.state !== "claimed" || record.ownerToken !== token) return record.state === "consumed" ? "already-consumed" : record.state;
        if (record.fingerprint !== fingerprint) return "fingerprint";
        if (record.responseFingerprint !== responseFp || record.resumeStreamId !== resumeStreamId) return "claim-mismatch";
        if (timestamp(record.expiresAt) <= now) {
          record.state = "expired";
          delete record.ownerToken;
          delete record.claimedAt;
          delete record.claimExpiresAt;
          delete record.responseFingerprint;
          delete record.resumeStreamId;
          record.updatedAt = String(now);
          hashes.get(tombstoneKey)!.state = "expired";
          delete hashes.get(tombstoneKey)!.jobId;
          delete hashes.get(tombstoneKey)!.resumeStreamId;
          physicalExpiresAt.set(key, Math.max(now, timestamp(record.expiresAt)) + INTERACTION_EXPIRED_RETENTION_SECONDS * 1_000);
          return "expired";
        }
        record.state = "consumed";
        record.response = responseJson;
        record.responseFingerprint = responseFp;
        record.resumeStreamId = resumeStreamId;
        record.jobId = jobId;
        record.consumedAt = String(now);
        record.updatedAt = record.consumedAt;
        delete record.ownerToken;
        delete record.claimedAt;
        delete record.claimExpiresAt;
        hashes.get(tombstoneKey)!.state = "consumed";
        hashes.get(tombstoneKey)!.jobId = jobId!;
        hashes.get(tombstoneKey)!.resumeStreamId = resumeStreamId!;
        physicalExpiresAt.set(key, Math.max(now, timestamp(record.expiresAt)) + INTERACTION_CONSUMED_RETENTION_SECONDS * 1_000);
        return "consumed";
      }
      throw new Error("unknown interaction store script");
    }),
    hgetall: vi.fn(async (key: string) => {
      expireIfNeeded(key);
      return { ...(hashes.get(key) ?? {}) };
    }),
    __hashes: hashes,
    __physicalExpiresAt: physicalExpiresAt,
    __evalCalls: evalCalls,
    __setNow(value: number) { serverNow = value; },
  };
  return redis;
}

function setup() {
  const redis = createFakeRedis();
  const store = createInteractionStore(redis);
  return { redis, store };
}

function putInput(overrides: Record<string, unknown> = {}) {
  return {
    request,
    continuation,
    recipe,
    sourceStreamId: STREAM_ID,
    sourceRunId: "run-1",
    ownership: { userId: USER_ID, sessionId: SESSION_ID },
    ...overrides,
  };
}

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    sessionId: SESSION_ID,
    resumeStreamId: "resume-stream-1",
    response,
    ...overrides,
  };
}

function consumeInput(token: string | undefined, overrides: Record<string, unknown> = {}) {
  return {
    id: request.id,
    userId: USER_ID,
    sessionId: SESSION_ID,
    ...(token === undefined ? {} : { token }),
    resumeStreamId: "resume-stream-1",
    jobId: "chat-resume:interaction-1",
    response,
    ...overrides,
  };
}

describe("InteractionStore", () => {
  it("persists a pending continuation, atomically claims it, and consumes it", async () => {
    const { redis, store } = setup();
    const pending = await store.put(putInput());

    expect(pending).toMatchObject({
      id: request.id,
      state: "pending",
      userId: USER_ID,
      sessionId: SESSION_ID,
      sourceStreamId: STREAM_ID,
      sourceRunId: "run-1",
      request,
      continuation,
      recipe,
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(interactionKey(request.id)).toMatch(/^chat-interaction:\{[a-f0-9]{64}\}$/);
    expect(redis.__evalCalls[0]?.script).toContain("interaction-store:put");

    const claim = await store.claim(request.id, claimInput());
    expect(claim.record.state).toBe("claimed");
    expect(claim.token).toEqual(expect.any(String));

    const consumed = await store.consume(consumeInput(claim.token));
    expect(consumed.state).toBe("consumed");
    expect(consumed.response).toEqual(response);
    await expect(store.get(request.id)).resolves.toMatchObject({ state: "consumed" });
  });

  it("rejects same-id same-type requests whose complete payload differs from the continuation", async () => {
    const { store } = setup();
    const mismatchedRequest = parseAgentInteractionRequest({
      ...request,
      input: { query: "different" },
    });
    await expect(store.put(putInput({ request: mismatchedRequest }))).rejects.toBeInstanceOf(InteractionTypeError);
  });

  it("validates the official response before claiming and leaves invalid input pending", async () => {
    const { store } = setup();
    await store.put(putInput());
    await expect(store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      resumeStreamId: "resume-stream-1",
      response: { type: "tool-question", answers: [] },
    } as never)).rejects.toBeInstanceOf(InteractionTypeError);
    await expect(store.get(request.id)).resolves.toMatchObject({ state: "pending" });
  });

  it("atomically binds the resume stream and response fingerprint to claim and consume", async () => {
    const { store } = setup();
    await store.put(putInput());
    const claim = await store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      resumeStreamId: "resume-stream-a",
      response,
    } as never);
    expect(claim.record).toMatchObject({ state: "claimed", resumeStreamId: "resume-stream-a" });
    await expect(store.consume({
      id: request.id,
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: claim.token,
      resumeStreamId: "resume-stream-b",
      jobId: "chat-resume:interaction-1",
      response,
    } as never)).rejects.toMatchObject({ code: "claim_mismatch" });
    await expect(store.consume({
      id: request.id,
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: claim.token,
      resumeStreamId: "resume-stream-a",
      jobId: "chat-resume:interaction-1",
      response,
    } as never)).resolves.toMatchObject({ state: "consumed", resumeStreamId: "resume-stream-a" });
  });

  it("allows only one concurrent owner to claim a pending interaction", async () => {
    const { store, redis } = setup();
    await store.put(putInput());
    const claims = await Promise.allSettled([
      store.claim(request.id, claimInput()),
      store.claim(request.id, claimInput()),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
  });

  it("treats an identical put as idempotent but rejects a conflicting payload", async () => {
    const { store } = setup();
    const first = await store.put(putInput());
    const second = await store.put(putInput());
    expect(second).toMatchObject({ id: first.id, fingerprint: first.fingerprint, state: "pending" });
    await expect(store.put(putInput({ sourceStreamId: "other-stream" }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("releases a claim when enqueue fails so another request can retry", async () => {
    const { store } = setup();
    await store.put(putInput());
    const first = await store.claim(request.id, claimInput());
    await expect(
      store.release({ id: request.id, userId: USER_ID, sessionId: SESSION_ID, token: first.token }),
    ).resolves.toMatchObject({ state: "pending" });
    const second = await store.claim(request.id, claimInput());
    expect(second.token).not.toBe(first.token);
  });

  it("retries an owned claim idempotently and reaps an abandoned claim lease", async () => {
    const { store, redis } = setup();
    await store.put(putInput());
    const first = await store.claim(request.id, claimInput({ token: "token-a" }));
    const retry = await store.claim(request.id, claimInput({ token: first.token }));
    expect(retry.token).toBe(first.token);
    redis.__setNow(Date.now() + 121_000);
    const reaped = await store.claim(request.id, claimInput({ token: "token-b" }));
    expect(reaped.token).toBe("token-b");
  });

  it("does not return a dead same-token claim after the lease expires", async () => {
    const { store, redis } = setup();
    await store.put(putInput());
    const first = await store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: "token-a",
      resumeStreamId: "resume-stream-a",
      response,
    } as never);
    redis.__setNow(Date.now() + 121_000);
    await expect(store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: first.token,
      resumeStreamId: "resume-stream-a",
      response,
    } as never)).rejects.toMatchObject({ code: "stale_claim" });
    const recovered = await store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: "token-b",
      resumeStreamId: "resume-stream-a",
      response,
    } as never);
    await expect(store.consume({
      id: request.id,
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: recovered.token,
      resumeStreamId: "resume-stream-a",
      jobId: "chat-resume:interaction-1",
      response,
    } as never)).resolves.toMatchObject({ state: "consumed" });
  });

  it("does not rebind an expired accepted claim to another resume stream", async () => {
    const { store, redis } = setup();
    await store.put(putInput());
    await store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: "token-a",
      resumeStreamId: "resume-stream-a",
      response,
    } as never);
    redis.__setNow(Date.now() + 121_000);
    await expect(store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: "token-b",
      resumeStreamId: "resume-stream-b",
      response,
    } as never)).rejects.toMatchObject({ code: "claim_mismatch" });
    await expect(store.get(request.id)).resolves.toMatchObject({ state: "claimed", resumeStreamId: "resume-stream-a" });
    const recovered = await store.claim(request.id, {
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: "token-b",
      resumeStreamId: "resume-stream-a",
      response,
    } as never);
    await expect(store.consume({
      id: request.id,
      userId: USER_ID,
      sessionId: SESSION_ID,
      token: recovered.token,
      resumeStreamId: "resume-stream-a",
      jobId: "chat-resume:interaction-1",
      response,
    } as never)).resolves.toMatchObject({ state: "consumed" });
  });

  it("rejects wrong ownership, wrong response type, and wrong claim tokens", async () => {
    const { store } = setup();
    await store.put(putInput());
    await expect(store.claim(request.id, claimInput({ userId: "other-user" }))).rejects.toBeInstanceOf(InteractionOwnershipError);
    const claim = await store.claim(request.id, claimInput());
    await expect(store.consume(consumeInput("wrong-token"))).rejects.toMatchObject({ code: "state" });
    await expect(store.consume(consumeInput(claim.token, { response: { type: "tool-question", answers: [] } }))).rejects.toBeInstanceOf(InteractionTypeError);
    await expect(store.get(request.id, { userId: "other-user", sessionId: SESSION_ID })).rejects.toBeInstanceOf(InteractionOwnershipError);
  });

  it("masks terminal tombstones from a wrong user without accepting a client session", async () => {
    const expired = setup();
    const createdAt = Date.parse("2026-08-24T00:00:00.000Z");
    expired.redis.__setNow(createdAt);
    await expired.store.put(putInput({ ttlSeconds: 1 }));
    expired.redis.__setNow(createdAt + 2_000);
    await expect(expired.store.get(request.id)).resolves.toMatchObject({ state: "expired" });
    expired.redis.__hashes.delete(interactionKey(request.id));
    await expect(expired.store.getForUser(request.id, "other-user")).rejects.toBeInstanceOf(InteractionOwnershipError);
    await expect(expired.store.getForUser(request.id, USER_ID)).rejects.toMatchObject({ code: "expired" });

    const consumed = setup();
    await consumed.store.put(putInput());
    const claim = await consumed.store.claim(request.id, claimInput());
    await consumed.store.consume(consumeInput(claim.token));
    consumed.redis.__hashes.delete(interactionKey(request.id));
    await expect(consumed.store.getForUser(request.id, "other-user")).rejects.toBeInstanceOf(InteractionOwnershipError);
    await expect(consumed.store.getForUser(request.id, USER_ID)).rejects.toMatchObject({ code: "replayed" });
  });

  it("rejects a continuation with the wrong agent even when its recipe is otherwise valid", async () => {
    const { store } = setup();
    const otherAgentContinuation = parseAgentContinuation({
      ...continuation,
      agentId: "other-agent",
    });
    await expect(store.put(putInput({ continuation: otherAgentContinuation }))).rejects.toBeInstanceOf(InteractionTypeError);
  });

  it("rejects duplicate submit and replay after consume", async () => {
    const { store, redis } = setup();
    await store.put(putInput());
    const claim = await store.claim(request.id, claimInput());
    await store.consume(consumeInput(claim.token));
    await expect(store.claim(request.id, claimInput())).rejects.toMatchObject({ code: "replayed" });
    await expect(store.consume(consumeInput(claim.token))).resolves.toMatchObject({ state: "consumed" });
  });

  it("marks an expired continuation and never allows it to be claimed", async () => {
    const { store, redis } = setup();
    const createdAt = Date.parse("2026-08-24T00:00:00.000Z");
    redis.__setNow(createdAt);
    await store.put(putInput({ ttlSeconds: 1 }));
    redis.__setNow(createdAt + 2_000);
    await expect(store.claim(request.id, claimInput())).rejects.toMatchObject({ code: "expired" });
    await expect(store.get(request.id)).resolves.toMatchObject({ state: "expired" });
  });

  it("rejects an identical put after logical expiry with a stable expired code", async () => {
    const { store, redis } = setup();
    const createdAt = Date.parse("2026-08-24T00:00:00.000Z");
    redis.__setNow(createdAt);
    await store.put(putInput({ ttlSeconds: 1 }));
    redis.__setNow(createdAt + 2_000);
    await expect(store.put(putInput({ ttlSeconds: 1 }))).rejects.toMatchObject({ code: "expired" });
  });

  it("retains logical expiry tombstones and applies state-specific physical retention", async () => {
    const { store, redis } = setup();
    const createdAt = Date.parse("2026-08-24T00:00:00.000Z");
    redis.__setNow(createdAt);
    await store.put(putInput({ ttlSeconds: 1 }));
    const key = interactionKey(request.id);
    expect(redis.__physicalExpiresAt.get(key)).toBe(
      createdAt + 1_000 + INTERACTION_PENDING_RETENTION_SECONDS * 1_000,
    );

    const claim = await store.claim(request.id, claimInput());
    expect(redis.__physicalExpiresAt.get(key)).toBe(
      createdAt + 1_000 + INTERACTION_CLAIMED_RETENTION_SECONDS * 1_000,
    );
    await store.consume(consumeInput(claim.token));
    expect(redis.__physicalExpiresAt.get(key)).toBe(
      createdAt + 1_000 + INTERACTION_CONSUMED_RETENTION_SECONDS * 1_000,
    );

    // A pending record is converted to an `expired` tombstone before the
    // logical deadline, and remains readable until its expiry retention ends.
    const { store: pendingStore, redis: pendingRedis } = setup();
    pendingRedis.__setNow(createdAt);
    await pendingStore.put(putInput({ ttlSeconds: 1 }));
    pendingRedis.__setNow(createdAt + 2_000);
    await expect(pendingStore.get(request.id)).resolves.toMatchObject({ state: "expired" });
    pendingRedis.__setNow(createdAt + 2_000 + INTERACTION_EXPIRED_RETENTION_SECONDS * 1_000 + 1);
    await expect(pendingStore.get(request.id)).rejects.toMatchObject({ code: "expired" });
  });

  it("reconciles a duplicate accepted job idempotently without a claim token", async () => {
    const { store } = setup();
    await store.put(putInput());
    const claim = await store.claim(request.id, claimInput());
    const jobId = "chat-resume:interaction-1";
    await store.consume(consumeInput(claim.token, { jobId }));
    await expect(store.consume(consumeInput(undefined, { jobId }))).resolves.toMatchObject({
      state: "consumed",
      jobId,
    });
    await expect(store.consume(consumeInput(undefined, { jobId: "chat-resume:other" }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects corrupt or unknown Redis fields at the strict storage boundary", async () => {
    const { store, redis } = setup();
    await store.put(putInput());
    const raw = redis.__hashes.get(interactionKey(request.id));
    raw!.debug = "prompt leak";
    await expect(store.get(request.id)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects corrupt tombstones instead of treating them as replay state", async () => {
    const { store, redis } = setup();
    await store.put(putInput());
    redis.__hashes.delete(interactionKey(request.id));
    redis.__hashes.get(interactionTombstoneKey(request.id))!.debug = "must-not-be-read";
    await expect(store.get(request.id)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects response bindings on pending/expired records and claim fields on consumed records", async () => {
    const pending = setup();
    await pending.store.put(putInput());
    const pendingRaw = pending.redis.__hashes.get(interactionKey(request.id))!;
    pendingRaw.responseFingerprint = "a".repeat(64);
    pendingRaw.resumeStreamId = "resume-stream-for-pending";
    await expect(pending.store.get(request.id)).rejects.toMatchObject({ code: "corrupt" });

    const expired = setup();
    const expiredAt = Date.parse("2026-08-24T00:00:00.000Z");
    expired.redis.__setNow(expiredAt);
    await expired.store.put(putInput({ ttlSeconds: 1 }));
    expired.redis.__setNow(expiredAt + 2_000);
    await expect(expired.store.get(request.id)).resolves.toMatchObject({ state: "expired" });
    const expiredRaw = expired.redis.__hashes.get(interactionKey(request.id))!;
    expiredRaw.responseFingerprint = "b".repeat(64);
    expiredRaw.resumeStreamId = "resume-stream-for-expired";
    await expect(expired.store.get(request.id)).rejects.toMatchObject({ code: "corrupt" });

    const consumed = setup();
    await consumed.store.put(putInput());
    const claim = await consumed.store.claim(request.id, claimInput());
    await consumed.store.consume(consumeInput(claim.token));
    consumed.redis.__hashes.get(interactionKey(request.id))!.ownerToken = "stale-claim";
    await expect(consumed.store.get(request.id)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("uses a finite replay horizon and returns not_found after both keys expire", async () => {
    const { store, redis } = setup();
    const createdAt = Date.parse("2026-08-24T00:00:00.000Z");
    redis.__setNow(createdAt);
    await store.put(putInput({ ttlSeconds: 1 }));
    redis.__setNow(createdAt + 2_000);
    await expect(store.put(putInput({ ttlSeconds: 1 }))).rejects.toMatchObject({ code: "expired" });

    redis.__setNow(createdAt + INTERACTION_TOMBSTONE_RETENTION_SECONDS * 1_000 + 1);
    await expect(store.get(request.id)).resolves.toBeNull();
    await expect(store.put(putInput({ ttlSeconds: 1 }))).resolves.toMatchObject({ state: "pending" });
  });

  it.each([
    ["id", "different-id"],
    ["sourceRunId", "different-run"],
  ])("rejects a recomputed-but-inconsistent stored %s invariant", async (field, value) => {
    const { store, redis } = setup();
    await store.put(putInput());
    const raw = redis.__hashes.get(interactionKey(request.id))!;
    raw[field] = value;
    await expect(store.get(request.id)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("can be recreated in another process using the same Redis record", async () => {
    const { redis, store } = setup();
    await store.put(putInput());
    const recreated = createInteractionStore(redis);
    const claim = await recreated.claim(request.id, claimInput());
    await expect(recreated.consume(consumeInput(claim.token))).resolves.toMatchObject({ state: "consumed" });
  });

  it("awaits durable persistence in the Task 9 callback and propagates failures", async () => {
    const { store } = setup();
    const onInteraction = createInteractionPersistenceCallback({
      store,
      recipe,
      ownership: { userId: USER_ID, sessionId: SESSION_ID, sourceStreamId: STREAM_ID },
    });
    await onInteraction({
      type: "interaction",
      runId: "run-1",
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      messages: [],
      interaction: request,
      continuation,
    });
    await expect(store.get(request.id)).resolves.toMatchObject({ state: "pending" });

    const failingStore = { onInteraction: vi.fn(async () => { throw new Error("redis unavailable"); }) } as unknown as ReturnType<typeof createInteractionStore>;
    await expect(createInteractionPersistenceCallback({
      store: failingStore,
      recipe,
      ownership: { userId: USER_ID, sessionId: SESSION_ID, sourceStreamId: STREAM_ID },
    })({
      type: "interaction",
      runId: "run-1",
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      messages: [],
      interaction: request,
      continuation,
    })).rejects.toThrow("redis unavailable");
  });
});
