import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createInteractionPolicyStore, interactionPolicyKey, interactionResponseFingerprint, InteractionPolicyConflictError, InteractionPolicyCorruptError } from "./interaction-policy-store.js";

let redis: Redis;
const ids = new Set<string>();
const make = () => { const interactionId = `policy-${randomUUID()}`; ids.add(interactionId); const responseFingerprint = interactionResponseFingerprint({ type: "tool-approval", approved: true }); return { interactionId, userId: "user-1", sessionId: "session-1", toolName: "generate_image", responseFingerprint, grantScope: "session" as const, overrideArgs: { aspectRatio: "16:9" }, ttlSeconds: 30 }; };
const bind = (input: ReturnType<typeof make>, claimToken = randomUUID()) => ({ ...input, claimToken, leaseSeconds: 2 });

describe("interaction policy claim lifecycle against production Redis Lua", () => {
  beforeAll(async () => { redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:16379"); await redis.ping(); });
  afterAll(async () => { for (const id of ids) await redis.del(interactionPolicyKey(id)); await redis.quit(); });
  it("stages, claims complete identity, releases, reclaims, and consumes", async () => { const input = make(); const store = createInteractionPolicyStore(redis as never); const tokenA = randomUUID(); const tokenB = randomUUID(); await store.stage(input); const first = await store.claim(bind(input, tokenA)); expect(first).toMatchObject({ state: "claimed", interactionId: input.interactionId, userId: input.userId, sessionId: input.sessionId, toolName: input.toolName, responseFingerprint: input.responseFingerprint, claimToken: tokenA }); await store.release({ interactionId: input.interactionId, claimToken: tokenA }); const reclaimed = await store.claim(bind(input, tokenB)); expect(reclaimed.claimToken).toBe(tokenB); await store.consume(bind(input, tokenB)); expect((await store.get(input.interactionId))?.state).toBe("consumed"); });
  it("rejects concurrent claim and wrong consume binding", async () => { const input = make(); const store = createInteractionPolicyStore(redis as never); await store.stage(input); await store.claim(bind(input, randomUUID())); await expect(store.claim(bind(input, randomUUID()))).rejects.toBeInstanceOf(InteractionPolicyConflictError); await expect(store.consume(bind(input, randomUUID()))).rejects.toBeInstanceOf(InteractionPolicyConflictError); });
  it("reclaims an expired claim using Redis server time", async () => { const input = make(); const store = createInteractionPolicyStore(redis as never); await store.stage(input); await store.claim({ ...bind(input, randomUUID()), leaseSeconds: 1 }); await new Promise((resolve) => setTimeout(resolve, 1100)); const tokenB = randomUUID(); const reclaimed = await store.claim(bind(input, tokenB)); expect(reclaimed.claimToken).toBe(tokenB); });
  it("fails closed on unknown fields in claimed and consume transitions", async () => { const input = make(); const store = createInteractionPolicyStore(redis as never); await store.stage(input); await redis.hset(interactionPolicyKey(input.interactionId), "unknown", "bad"); await expect(store.claim(bind(input))).rejects.toBeInstanceOf(InteractionPolicyCorruptError); });
  it("fails closed on unknown fields after claim before consume", async () => {
    const input = make();
    const store = createInteractionPolicyStore(redis as never);
    const token = randomUUID();
    await store.stage(input);
    await store.claim(bind(input, token));
    await redis.hset(interactionPolicyKey(input.interactionId), "unknown", "bad");
    await expect(store.consume(bind(input, token))).rejects.toBeInstanceOf(InteractionPolicyCorruptError);
  });
  it("fails closed when the claimed override JSON is corrupt", async () => {
    const input = make();
    const store = createInteractionPolicyStore(redis as never);
    const token = randomUUID();
    await store.stage(input);
    await redis.hset(interactionPolicyKey(input.interactionId), "overrideArgs", "{");
    await expect(store.claim(bind(input, token))).rejects.toBeInstanceOf(InteractionPolicyCorruptError);
  });
  it("does not retain executable fields after consumption", async () => { const input = make(); const store = createInteractionPolicyStore(redis as never); const token = randomUUID(); await store.stage(input); await store.claim(bind(input, token)); await store.consume(bind(input, token)); const raw = await redis.hgetall(interactionPolicyKey(input.interactionId)); expect(raw.grantScope).toBeUndefined(); expect(raw.overrideArgs).toBeUndefined(); expect(raw.claimToken).toBeUndefined(); });

  it("makes stage fail closed when a valid hash is corrupted after its pre-read", async () => {
    const input = make();
    const store = createInteractionPolicyStore(redis as never);
    await store.stage(input);
    const key = interactionPolicyKey(input.interactionId);
    const racingRedis = {
      hgetall: (requestedKey: string) => redis.hgetall(requestedKey),
      eval: async (script: string, keyCount: number, ...args: string[]) => {
        await redis.hset(key, "claimToken", "illegal-in-staged");
        return redis.eval(script, keyCount, ...args);
      },
    };

    await expect(createInteractionPolicyStore(racingRedis).stage(input)).rejects.toBeInstanceOf(
      InteractionPolicyCorruptError,
    );
  });

  it("rejects state-valid field names that violate staged invariants during claim", async () => {
    const input = make();
    const store = createInteractionPolicyStore(redis as never);
    await store.stage(input);
    await redis.hset(interactionPolicyKey(input.interactionId), "consumedAt", String(Date.now()));

    await expect(store.claim(bind(input))).rejects.toBeInstanceOf(InteractionPolicyCorruptError);
  });

  it("rejects a claimed record missing its lease during consume", async () => {
    const input = make();
    const store = createInteractionPolicyStore(redis as never);
    const token = randomUUID();
    await store.stage(input);
    await store.claim(bind(input, token));
    await redis.hdel(interactionPolicyKey(input.interactionId), "claimExpiresAt");

    await expect(store.consume(bind(input, token))).rejects.toBeInstanceOf(InteractionPolicyCorruptError);
  });

  it("validates schema and identity invariants before release mutates a claim", async () => {
    const input = make();
    const store = createInteractionPolicyStore(redis as never);
    const token = randomUUID();
    await store.stage(input);
    await store.claim(bind(input, token));
    await redis.hset(interactionPolicyKey(input.interactionId), "schemaVersion", "corrupt-version");

    await expect(store.release({ interactionId: input.interactionId, claimToken: token })).rejects.toBeInstanceOf(
      InteractionPolicyCorruptError,
    );
  });

  it("rejects terminal records that regain executable fields", async () => {
    const input = make();
    const store = createInteractionPolicyStore(redis as never);
    const token = randomUUID();
    await store.stage(input);
    await store.claim(bind(input, token));
    await store.consume(bind(input, token));
    await redis.hset(interactionPolicyKey(input.interactionId), "overrideArgs", "{}");

    await expect(store.claim(bind(input, randomUUID()))).rejects.toBeInstanceOf(InteractionPolicyCorruptError);
  });
});
