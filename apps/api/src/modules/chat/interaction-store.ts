import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  assertAgentInteractionResponse,
  parseAgentContinuation,
  parseAgentInteractionRequest,
  parseAgentInteractionResponse,
  type AgentContinuation,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type { AgentInteractionOutcome } from "@anvia/core/agent";
import { getRedis } from "../../lib/redis.js";
import {
  assertRecipeIdentity,
  CHAT_AGENT_ID,
  parseChatAgentRecipe,
  type ChatAgentRecipe,
} from "./run-recipe.js";

export const INTERACTION_SCHEMA_VERSION = "interaction-v1" as const;
export const INTERACTION_DEFAULT_TTL_SECONDS = 15 * 60;
export const INTERACTION_MAX_TTL_SECONDS = 24 * 60 * 60;
export const INTERACTION_CLAIM_LEASE_SECONDS = 2 * 60;
/** Redis retention is longer than logical expiry so expired records remain
 * durable tombstones for replay/double-submit reconciliation. */
export const INTERACTION_PENDING_RETENTION_SECONDS = 24 * 60 * 60;
export const INTERACTION_CLAIMED_RETENTION_SECONDS = 2 * 24 * 60 * 60;
export const INTERACTION_CONSUMED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const INTERACTION_EXPIRED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const INTERACTION_TOMBSTONE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const SERIALIZED_VALUE_MAX_BYTES = 512_000;

/**
 * Every mutation for an interaction uses one Redis key.  The braces are an
 * explicit Redis Cluster hash tag: scripts remain single-slot even when the
 * interaction id contains punctuation or a caller derives additional keys.
 */
const interactionDigest = (interactionId: string) =>
  createHash("sha256").update(interactionId).digest("hex");

export const interactionKey = (interactionId: string) =>
  `chat-interaction:{${interactionDigest(interactionId)}}`;

/** Replay marker has the same hash tag so all scripts remain one Cluster slot. */
export const interactionTombstoneKey = (interactionId: string) =>
  `chat-interaction-tombstone:{${interactionDigest(interactionId)}}`;

const PUT_SCRIPT = `-- interaction-store:put
if redis.call("EXISTS", KEYS[1]) == 1 then
  if redis.call("HGET", KEYS[1], "fingerprint") == ARGV[10] then return "same" end
  return "exists"
end
if redis.call("EXISTS", KEYS[2]) == 1 then return "replayed" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local expiresMs = nowMs + tonumber(ARGV[9]) * 1000
redis.call("HSET", KEYS[1],
  "schemaVersion", "${INTERACTION_SCHEMA_VERSION}",
  "id", ARGV[1], "userId", ARGV[2], "sessionId", ARGV[3],
  "sourceStreamId", ARGV[4], "sourceRunId", ARGV[5],
  "request", ARGV[6], "continuation", ARGV[7], "recipe", ARGV[8],
  "state", "pending", "createdAt", tostring(nowMs), "updatedAt", tostring(nowMs),
  "expiresAt", tostring(expiresMs), "fingerprint", ARGV[10])
redis.call("HSET", KEYS[2], "schemaVersion", "${INTERACTION_SCHEMA_VERSION}", "id", ARGV[1], "userId", ARGV[2], "sessionId", ARGV[3], "fingerprint", ARGV[10], "state", "pending", "expiresAt", tostring(expiresMs))
redis.call("PEXPIREAT", KEYS[1], tostring(expiresMs + ${INTERACTION_PENDING_RETENTION_SECONDS * 1000}))
redis.call("PEXPIREAT", KEYS[2], tostring(nowMs + ${INTERACTION_TOMBSTONE_RETENTION_SECONDS * 1000}))
return "stored"`;

const MARK_EXPIRED_SCRIPT = `-- interaction-store:expire
local state = redis.call("HGET", KEYS[1], "state")
local expiresAt = redis.call("HGET", KEYS[1], "expiresAt")
if not state then return "missing" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
if state ~= "consumed" and state ~= "expired" and expiresAt and tonumber(expiresAt) <= nowMs then
  redis.call("HSET", KEYS[1], "state", "expired", "updatedAt", tostring(nowMs))
  redis.call("HDEL", KEYS[1], "ownerToken", "claimedAt", "claimExpiresAt", "responseFingerprint", "resumeStreamId")
  redis.call("HSET", KEYS[2], "state", "expired")
  redis.call("HDEL", KEYS[2], "jobId", "resumeStreamId")
  redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, tonumber(expiresAt)) + ${INTERACTION_EXPIRED_RETENTION_SECONDS * 1000}))
  return "expired"
end
return state`;

const CLAIM_SCRIPT = `-- interaction-store:claim
local state = redis.call("HGET", KEYS[1], "state")
if not state then return "missing" end
if redis.call("HGET", KEYS[1], "userId") ~= ARGV[1] or redis.call("HGET", KEYS[1], "sessionId") ~= ARGV[2] then return "owner" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt") or "0")
if state ~= "consumed" and state ~= "expired" and expiresAt > 0 and expiresAt <= nowMs then
      redis.call("HSET", KEYS[1], "state", "expired", "updatedAt", tostring(nowMs))
      redis.call("HDEL", KEYS[1], "ownerToken", "claimedAt", "claimExpiresAt", "responseFingerprint", "resumeStreamId")
      redis.call("HSET", KEYS[2], "state", "expired")
      redis.call("HDEL", KEYS[2], "jobId", "resumeStreamId")
  redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, expiresAt) + ${INTERACTION_EXPIRED_RETENTION_SECONDS * 1000}))
  return "expired"
end
if ARGV[4] ~= "" and redis.call("HGET", KEYS[1], "fingerprint") ~= ARGV[4] then return "fingerprint" end
if state ~= "pending" then
  if state == "claimed" then
    local claimToken = redis.call("HGET", KEYS[1], "ownerToken")
    local claimExpiresAt = tonumber(redis.call("HGET", KEYS[1], "claimExpiresAt") or "0")
    if claimExpiresAt > 0 and claimExpiresAt <= nowMs then
      if claimToken == ARGV[3] then return "stale-claim" end
      if redis.call("HGET", KEYS[1], "responseFingerprint") ~= ARGV[5] or redis.call("HGET", KEYS[1], "resumeStreamId") ~= ARGV[6] then return "claim-mismatch" end
      redis.call("HSET", KEYS[1], "ownerToken", ARGV[3], "claimedAt", tostring(nowMs), "claimExpiresAt", tostring(nowMs + ${INTERACTION_CLAIM_LEASE_SECONDS * 1000}), "responseFingerprint", ARGV[5], "resumeStreamId", ARGV[6], "updatedAt", tostring(nowMs))
      redis.call("HDEL", KEYS[2], "jobId")
      redis.call("HSET", KEYS[2], "state", "claimed", "resumeStreamId", ARGV[6])
      redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, expiresAt) + ${INTERACTION_CLAIMED_RETENTION_SECONDS * 1000}))
      return "reclaimed"
    end
    if claimToken == ARGV[3] then
      if redis.call("HGET", KEYS[1], "responseFingerprint") ~= ARGV[5] or redis.call("HGET", KEYS[1], "resumeStreamId") ~= ARGV[6] then return "claim-mismatch" end
      return "same-claim"
    end
    return "already-claimed"
  end
  return state
end
redis.call("HSET", KEYS[1], "state", "claimed", "ownerToken", ARGV[3], "claimedAt", tostring(nowMs), "claimExpiresAt", tostring(nowMs + ${INTERACTION_CLAIM_LEASE_SECONDS * 1000}), "responseFingerprint", ARGV[5], "resumeStreamId", ARGV[6], "updatedAt", tostring(nowMs))
redis.call("HDEL", KEYS[2], "jobId")
redis.call("HSET", KEYS[2], "state", "claimed", "resumeStreamId", ARGV[6])
redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, expiresAt) + ${INTERACTION_CLAIMED_RETENTION_SECONDS * 1000}))
return "claimed"`;

const RELEASE_SCRIPT = `-- interaction-store:release
local state = redis.call("HGET", KEYS[1], "state")
if not state then return "missing" end
if redis.call("HGET", KEYS[1], "userId") ~= ARGV[1] or redis.call("HGET", KEYS[1], "sessionId") ~= ARGV[2] then return "owner" end
if state ~= "claimed" then return state end
if redis.call("HGET", KEYS[1], "ownerToken") ~= ARGV[3] then return "token" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt") or "0")
local claimExpiresAt = tonumber(redis.call("HGET", KEYS[1], "claimExpiresAt") or "0")
redis.call("HSET", KEYS[1], "state", "pending", "updatedAt", tostring(nowMs))
redis.call("HDEL", KEYS[1], "ownerToken", "claimedAt", "claimExpiresAt", "responseFingerprint", "resumeStreamId")
redis.call("HSET", KEYS[2], "state", "pending")
redis.call("HDEL", KEYS[2], "jobId", "resumeStreamId")
redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, expiresAt) + ${INTERACTION_PENDING_RETENTION_SECONDS * 1000}))
if claimExpiresAt > 0 and claimExpiresAt <= nowMs then return "lease-expired" end
return "released"`;

const CONSUME_SCRIPT = `-- interaction-store:consume
local state = redis.call("HGET", KEYS[1], "state")
if not state then return "missing" end
if redis.call("HGET", KEYS[1], "userId") ~= ARGV[1] or redis.call("HGET", KEYS[1], "sessionId") ~= ARGV[2] then return "owner" end
if state ~= "claimed" then
  if state == "consumed" then
    if redis.call("HGET", KEYS[1], "jobId") == ARGV[7] and redis.call("HGET", KEYS[1], "fingerprint") == ARGV[5] and redis.call("HGET", KEYS[1], "responseFingerprint") == ARGV[6] and redis.call("HGET", KEYS[1], "resumeStreamId") == ARGV[8] and redis.call("HGET", KEYS[1], "response") == ARGV[4] then return "already-consumed" end
    return "replay-conflict"
  end
  return state
end
if redis.call("HGET", KEYS[1], "ownerToken") ~= ARGV[3] then return "token" end
if redis.call("HGET", KEYS[1], "fingerprint") ~= ARGV[5] or redis.call("HGET", KEYS[1], "responseFingerprint") ~= ARGV[6] or redis.call("HGET", KEYS[1], "resumeStreamId") ~= ARGV[8] then return "claim-mismatch" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt") or "0")
if expiresAt > 0 and expiresAt <= nowMs then
  redis.call("HSET", KEYS[1], "state", "expired", "updatedAt", tostring(nowMs))
  redis.call("HDEL", KEYS[1], "ownerToken", "claimedAt", "claimExpiresAt", "responseFingerprint", "resumeStreamId")
  redis.call("HSET", KEYS[2], "state", "expired")
  redis.call("HDEL", KEYS[2], "jobId", "resumeStreamId")
  redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, expiresAt) + ${INTERACTION_EXPIRED_RETENTION_SECONDS * 1000}))
  return "expired"
end
local claimExpiresAt = tonumber(redis.call("HGET", KEYS[1], "claimExpiresAt") or "0")
if claimExpiresAt > 0 and claimExpiresAt <= nowMs then
  redis.call("HSET", KEYS[1], "state", "pending", "updatedAt", tostring(nowMs))
  redis.call("HDEL", KEYS[1], "ownerToken", "claimedAt", "claimExpiresAt", "responseFingerprint", "resumeStreamId")
  redis.call("HSET", KEYS[2], "state", "pending")
  redis.call("HDEL", KEYS[2], "jobId", "resumeStreamId")
  redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, expiresAt) + ${INTERACTION_PENDING_RETENTION_SECONDS * 1000}))
  return "lease-expired"
end
redis.call("HSET", KEYS[1], "state", "consumed", "response", ARGV[4], "responseFingerprint", ARGV[6], "jobId", ARGV[7], "resumeStreamId", ARGV[8], "consumedAt", tostring(nowMs), "updatedAt", tostring(nowMs))
redis.call("HDEL", KEYS[1], "ownerToken", "claimedAt", "claimExpiresAt")
redis.call("HSET", KEYS[2], "state", "consumed", "jobId", ARGV[7], "resumeStreamId", ARGV[8])
redis.call("PEXPIREAT", KEYS[1], tostring(math.max(nowMs, expiresAt) + ${INTERACTION_CONSUMED_RETENTION_SECONDS * 1000}))
return "consumed"`;

/** Narrow Redis contract keeps tests deterministic and protects the boundary. */
export type InteractionRedis = {
  eval: (script: string, keyCount: number, ...keysAndArgs: string[]) => Promise<unknown>;
  hgetall: (key: string) => Promise<Record<string, string>>;
};

export type InteractionState = "pending" | "claimed" | "consumed" | "expired";

export type InteractionOwnership = {
  userId: string;
  sessionId: string;
};

export type InteractionPersistenceOwnership = InteractionOwnership & {
  sourceStreamId: string;
};

export type InteractionRecord = {
  id: string;
  userId: string;
  sessionId: string;
  sourceStreamId: string;
  sourceRunId: string;
  request: AgentInteractionRequest;
  continuation: AgentContinuation;
  recipe: ChatAgentRecipe;
  state: InteractionState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  fingerprint: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  responseFingerprint?: string;
  resumeStreamId?: string;
  consumedAt?: string;
  jobId?: string;
  response?: AgentInteractionResponse;
};

export type InteractionClaim = {
  record: InteractionRecord;
  token: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function boundedJson(value: unknown, field: string): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > SERIALIZED_VALUE_MAX_BYTES) {
    throw new InteractionTypeError(`${field} exceeds the serialized size bound`);
  }
  return encoded;
}

function responseFingerprint(response: AgentInteractionResponse): string {
  return createHash("sha256").update(boundedJson(response, "response")).digest("hex");
}

function interactionFingerprint(input: {
  id: string;
  userId: string;
  sessionId: string;
  sourceStreamId: string;
  sourceRunId: string;
  request: AgentInteractionRequest;
  continuation: AgentContinuation;
  recipe: ChatAgentRecipe;
}): string {
  const payload = boundedJson(input, "interaction");
  return createHash("sha256").update(payload).digest("hex");
}

function parseTimestamp(value: string, field: string): string {
  const milliseconds = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new InteractionTypeError(`stored ${field} timestamp is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

export class InteractionStoreError extends Error {
  constructor(
    message: string,
    public code:
      | "not_found"
      | "ownership"
      | "state"
      | "type"
      | "duplicate"
      | "fingerprint"
      | "expired"
      | "replayed"
      | "claimed"
      | "conflict"
      | "claim_mismatch"
      | "stale_claim"
      | "corrupt",
  ) {
    super(message);
    this.name = "InteractionStoreError";
  }
}

export class InteractionNotFoundError extends InteractionStoreError {
  constructor(id: string) {
    super(`interaction ${id} was not found`, "not_found");
    this.name = "InteractionNotFoundError";
  }
}

export class InteractionOwnershipError extends InteractionStoreError {
  constructor(id: string) {
    super(`interaction ${id} is not owned by this user and session`, "ownership");
    this.name = "InteractionOwnershipError";
  }
}

export class InteractionStateError extends InteractionStoreError {
  constructor(id: string, state: string) {
    super(`interaction ${id} cannot transition from ${state}`, "state");
    this.name = "InteractionStateError";
  }
}

export class InteractionTypeError extends InteractionStoreError {
  constructor(message: string) {
    super(message, "type");
    this.name = "InteractionTypeError";
  }
}

export class InteractionCorruptError extends InteractionTypeError {
  constructor(message: string) {
    super(message);
    this.name = "InteractionCorruptError";
    this.code = "corrupt";
  }
}

export class InteractionExpiredError extends InteractionStoreError {
  constructor(id: string) { super(`interaction ${id} has expired`, "expired"); this.name = "InteractionExpiredError"; }
}

export class InteractionReplayedError extends InteractionStoreError {
  constructor(id: string) { super(`interaction ${id} has already been replayed`, "replayed"); this.name = "InteractionReplayedError"; }
}

export class InteractionClaimedError extends InteractionStoreError {
  constructor(id: string) { super(`interaction ${id} is already claimed`, "claimed"); this.name = "InteractionClaimedError"; }
}

export class InteractionConflictError extends InteractionStoreError {
  constructor(message: string) { super(message, "conflict"); this.name = "InteractionConflictError"; }
}

export class InteractionClaimMismatchError extends InteractionStoreError {
  constructor(id: string) { super(`interaction ${id} claim binding does not match`, "claim_mismatch"); this.name = "InteractionClaimMismatchError"; }
}

export class InteractionStaleClaimError extends InteractionStoreError {
  constructor(id: string) { super(`interaction ${id} claim lease has expired`, "stale_claim"); this.name = "InteractionStaleClaimError"; }
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new InteractionTypeError(`${field} must be a nonblank bounded string`);
  }
}

function jsonParse(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new InteractionTypeError(`stored ${field} is not valid JSON`);
  }
}

function parseState(value: string, id: string): InteractionState {
  if (value === "pending" || value === "claimed" || value === "consumed" || value === "expired") return value;
  throw new InteractionTypeError(`stored interaction ${id} has an invalid state`);
}

function nowIso(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new InteractionTypeError("invalid interaction timestamp");
  return now.toISOString();
}

function ownershipMatches(record: InteractionRecord, ownership: InteractionOwnership): boolean {
  return record.userId === ownership.userId && record.sessionId === ownership.sessionId;
}

function operationError(id: string, result: string): never {
  switch (result) {
    case "missing":
      throw new InteractionNotFoundError(id);
    case "owner":
      throw new InteractionOwnershipError(id);
    case "exists":
      throw new InteractionConflictError(`interaction ${id} already exists with a different immutable fingerprint`);
    case "same":
      throw new InteractionStoreError(`interaction ${id} already exists`, "duplicate");
    case "replayed":
      throw new InteractionReplayedError(id);
    case "already-claimed":
      throw new InteractionClaimedError(id);
    case "stale-claim":
      throw new InteractionStaleClaimError(id);
    case "claim-mismatch":
      throw new InteractionClaimMismatchError(id);
    case "fingerprint":
      throw new InteractionConflictError(`interaction ${id} fingerprint changed`);
    case "replay-conflict":
      throw new InteractionConflictError(`interaction ${id} replay binding conflicts`);
    case "consume-conflict":
      throw new InteractionConflictError(`interaction ${id} consume binding conflicts`);
    case "token":
      throw new InteractionClaimMismatchError(id);
    case "expired":
      throw new InteractionExpiredError(id);
    case "consumed":
    case "already-consumed":
      throw new InteractionReplayedError(id);
    case "pending":
    case "claimed":
    case "lease-expired":
    case "same-claim":
    case "reclaimed":
      throw new InteractionStateError(id, result);
    default:
      throw new InteractionStoreError(`unknown interaction state transition: ${result}`, "state");
  }
}

type InteractionTombstone = {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  userId?: string;
  sessionId?: string;
  state: InteractionState;
  expiresAt: string;
  resumeStreamId?: string;
  jobId?: string;
};

function parseTombstone(raw: Record<string, string>, expectedId: string): InteractionTombstone {
  const allowed = new Set([
    "schemaVersion", "id", "userId", "sessionId", "fingerprint", "state", "expiresAt", "resumeStreamId", "jobId",
  ]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new InteractionTypeError(`stored interaction tombstone has unknown fields: ${unknown.join(",")}`);
  if (raw.schemaVersion !== INTERACTION_SCHEMA_VERSION || raw.id !== expectedId) {
    throw new InteractionTypeError(`stored interaction ${expectedId} tombstone identity is invalid`);
  }
  if (!/^[a-f0-9]{64}$/.test(raw.fingerprint ?? "")) {
    throw new InteractionTypeError(`stored interaction ${expectedId} tombstone fingerprint is invalid`);
  }
  if (raw.userId !== undefined) assertIdentity(raw.userId, "tombstone userId");
  if (raw.sessionId !== undefined) assertIdentity(raw.sessionId, "tombstone sessionId");
  const state = parseState(raw.state ?? "", expectedId);
  const expiresAt = parseTimestamp(raw.expiresAt ?? "", "tombstone expiresAt");
  if (raw.resumeStreamId !== undefined) assertIdentity(raw.resumeStreamId, "tombstone resumeStreamId");
  if (raw.jobId !== undefined) assertIdentity(raw.jobId, "tombstone jobId");
  if ((state === "pending" || state === "expired") && (raw.resumeStreamId !== undefined || raw.jobId !== undefined)) {
    throw new InteractionTypeError(`stored interaction ${expectedId} tombstone has completion fields in ${state} state`);
  }
  if (state === "claimed" && raw.resumeStreamId === undefined) {
    throw new InteractionTypeError(`stored interaction ${expectedId} tombstone has no resume stream binding`);
  }
  if (state === "claimed" && raw.jobId !== undefined) {
    throw new InteractionTypeError(`stored interaction ${expectedId} tombstone has a job marker before consume`);
  }
  if (state === "consumed" && (raw.resumeStreamId === undefined || raw.jobId === undefined)) {
    throw new InteractionTypeError(`stored interaction ${expectedId} tombstone has no job reconciliation marker`);
  }
  return {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    id: expectedId,
    fingerprint: raw.fingerprint,
    ...(raw.userId ? { userId: raw.userId } : {}),
    ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
    state,
    expiresAt,
    ...(raw.resumeStreamId ? { resumeStreamId: raw.resumeStreamId } : {}),
    ...(raw.jobId ? { jobId: raw.jobId } : {}),
  };
}

function parseTombstoneOrCorrupt(raw: Record<string, string>, expectedId: string): InteractionTombstone {
  try {
    return parseTombstone(raw, expectedId);
  } catch (error) {
    if (error instanceof InteractionCorruptError) throw error;
    throw new InteractionCorruptError(error instanceof Error ? error.message : "stored interaction tombstone is corrupt");
  }
}

function parseStoredRecord(raw: Record<string, string>): InteractionRecord {
  const allowed = new Set([
    "schemaVersion", "id", "userId", "sessionId", "sourceStreamId", "sourceRunId", "request",
    "continuation", "recipe", "state", "createdAt", "updatedAt", "expiresAt",
    "fingerprint", "ownerToken", "claimedAt", "claimExpiresAt", "responseFingerprint", "resumeStreamId", "consumedAt", "response", "jobId",
  ]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new InteractionTypeError(`stored interaction has unknown fields: ${unknown.join(",")}`);
  const id = raw.id ?? "";
  if (raw.schemaVersion !== INTERACTION_SCHEMA_VERSION) throw new InteractionTypeError(`stored interaction ${id || "?"} has an unsupported schema version`);
  assertIdentity(id, "interaction id");
  const state = parseState(raw.state ?? "", id);
  assertIdentity(raw.userId ?? "", "userId");
  assertIdentity(raw.sessionId ?? "", "sessionId");
  assertIdentity(raw.sourceStreamId ?? "", "sourceStreamId");
  assertIdentity(raw.sourceRunId ?? "", "sourceRunId");
  if (!/^[a-f0-9]{64}$/.test(raw.fingerprint ?? "")) {
    throw new InteractionTypeError(`stored interaction ${id} has an invalid fingerprint`);
  }
  const createdAt = parseTimestamp(raw.createdAt ?? "", "createdAt");
  const updatedAt = parseTimestamp(raw.updatedAt ?? "", "updatedAt");
  const expiresAt = parseTimestamp(raw.expiresAt ?? "", "expiresAt");
  if (raw.ownerToken !== undefined) assertIdentity(raw.ownerToken, "ownerToken");
  if (raw.jobId !== undefined) assertIdentity(raw.jobId, "jobId");
  if (raw.resumeStreamId !== undefined) assertIdentity(raw.resumeStreamId, "resumeStreamId");
  if (raw.responseFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(raw.responseFingerprint)) throw new InteractionTypeError("stored interaction has an invalid response fingerprint");
  if (raw.claimExpiresAt !== undefined) parseTimestamp(raw.claimExpiresAt, "claimExpiresAt");
  if (raw.state === "claimed" && raw.ownerToken === undefined) throw new InteractionTypeError("claimed interaction has no owner token");
  if (raw.state === "claimed" && raw.claimedAt === undefined) throw new InteractionTypeError("claimed interaction has no claim timestamp");
  if (raw.state === "claimed" && raw.claimExpiresAt === undefined) throw new InteractionTypeError("claimed interaction has no claim lease");
  if (raw.state === "claimed" && (raw.responseFingerprint === undefined || raw.resumeStreamId === undefined)) throw new InteractionTypeError("claimed interaction has no response binding");
  if (raw.state !== "claimed" && (raw.ownerToken !== undefined || raw.claimedAt !== undefined || raw.claimExpiresAt !== undefined)) throw new InteractionTypeError("non-claimed interaction has ownership fields");
  if ((raw.state === "pending" || raw.state === "expired") && (raw.responseFingerprint !== undefined || raw.resumeStreamId !== undefined)) throw new InteractionTypeError(`non-claimed interaction has response binding in ${raw.state} state`);
  if (raw.state === "consumed" && (raw.ownerToken !== undefined || raw.claimedAt !== undefined || raw.claimExpiresAt !== undefined)) throw new InteractionTypeError("consumed interaction has claim fields");
  if (raw.state === "consumed" && (raw.jobId === undefined || raw.consumedAt === undefined || raw.responseFingerprint === undefined || raw.resumeStreamId === undefined)) throw new InteractionTypeError("consumed interaction has no job reconciliation marker");
  if (raw.state !== "consumed" && (raw.jobId !== undefined || raw.consumedAt !== undefined || raw.response !== undefined)) throw new InteractionTypeError("non-consumed interaction has completion fields");
  const request = parseAgentInteractionRequest(jsonParse(raw.request ?? "", "request"));
  const continuation = parseAgentContinuation(jsonParse(raw.continuation ?? "", "continuation"));
  const recipe = parseChatAgentRecipe(jsonParse(raw.recipe ?? "", "recipe"));
  if (id !== request.id || raw.sourceRunId !== continuation.sourceRunId || continuation.agentId !== CHAT_AGENT_ID || continuation.agentId !== recipe.agentId || boundedJson(request, "request") !== boundedJson(continuation.interaction, "continuation interaction")) {
    throw new InteractionTypeError("stored request and continuation do not match");
  }
  assertRecipeIdentity(recipe, { userId: raw.userId, sessionId: raw.sessionId });
  const fingerprint = interactionFingerprint({
    id,
    userId: raw.userId,
    sessionId: raw.sessionId,
    sourceStreamId: raw.sourceStreamId,
    sourceRunId: raw.sourceRunId,
    request,
    continuation,
    recipe,
  });
  if (fingerprint !== raw.fingerprint) throw new InteractionTypeError(`stored interaction ${id} fingerprint does not match payload`);
  if (raw.response !== undefined && state !== "consumed") throw new InteractionTypeError("only consumed interactions may store a response");
  if (state === "consumed" && raw.response === undefined) throw new InteractionTypeError("consumed interaction has no response");
  const result: InteractionRecord = {
    id,
    userId: raw.userId,
    sessionId: raw.sessionId,
    sourceStreamId: raw.sourceStreamId,
    sourceRunId: raw.sourceRunId,
    request,
    continuation,
    recipe,
    state,
    createdAt,
    updatedAt,
    expiresAt,
    fingerprint,
    ...(raw.responseFingerprint ? { responseFingerprint: raw.responseFingerprint } : {}),
    ...(raw.resumeStreamId ? { resumeStreamId: raw.resumeStreamId } : {}),
    ...(raw.claimedAt ? { claimedAt: parseTimestamp(raw.claimedAt, "claimedAt") } : {}),
    ...(raw.claimExpiresAt ? { claimExpiresAt: parseTimestamp(raw.claimExpiresAt, "claimExpiresAt") } : {}),
    ...(raw.consumedAt ? { consumedAt: parseTimestamp(raw.consumedAt, "consumedAt") } : {}),
    ...(raw.jobId ? { jobId: raw.jobId } : {}),
  };
  if (raw.response) {
    const response = parseAgentInteractionResponse(jsonParse(raw.response, "response"));
    assertAgentInteractionResponse(request, response);
    if (responseFingerprint(response) !== raw.responseFingerprint) throw new InteractionTypeError("stored interaction response fingerprint does not match payload");
    result.response = response;
  }
  return result;
}

function parseStoredRecordOrCorrupt(raw: Record<string, string>): InteractionRecord {
  try {
    return parseStoredRecord(raw);
  } catch (error) {
    if (error instanceof InteractionCorruptError) throw error;
    throw new InteractionCorruptError(error instanceof Error ? error.message : "stored interaction is corrupt");
  }
}

export type InteractionPutInput = {
  request: AgentInteractionRequest | unknown;
  continuation: AgentContinuation | unknown;
  recipe: ChatAgentRecipe | unknown;
  sourceStreamId: string;
  sourceRunId?: string;
  ownership: InteractionOwnership;
  now?: Date;
  ttlSeconds?: number;
};

export type InteractionClaimInput = InteractionOwnership & {
  now?: Date;
  token?: string;
  /** Immutable payload fingerprint checked again inside the claim Lua script. */
  fingerprint?: string;
  response: AgentInteractionResponse | unknown;
  resumeStreamId: string;
};

export type InteractionTokenInput = InteractionOwnership & {
  id: string;
  token: string;
};

export type InteractionConsumeInput = InteractionOwnership & {
  id: string;
  /** Omitted only for idempotent reconciliation of an already-consumed job. */
  token?: string;
  jobId: string;
  resumeStreamId: string;
  response: AgentInteractionResponse | unknown;
};

export function createInteractionStore(
  redis: InteractionRedis,
  options: { ttlSeconds?: number } = {},
) {
  const defaultTtlSeconds = options.ttlSeconds ?? INTERACTION_DEFAULT_TTL_SECONDS;

  const get = async (
    id: string,
    ownership?: InteractionOwnership,
    _now: Date = new Date(),
  ): Promise<InteractionRecord | null> => {
    assertIdentity(id, "interaction id");
    const key = interactionKey(id);
    let raw = await redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) {
      const tombstone = await redis.hgetall(interactionTombstoneKey(id));
      if (!tombstone || Object.keys(tombstone).length === 0) return null;
      const parsedTombstone = parseTombstoneOrCorrupt(tombstone, id);
      if (ownership && (parsedTombstone.userId !== ownership.userId || parsedTombstone.sessionId !== ownership.sessionId)) throw new InteractionOwnershipError(id);
      if (parsedTombstone.state === "expired" || parsedTombstone.state === "pending") throw new InteractionExpiredError(id);
      if (parsedTombstone.state === "consumed") throw new InteractionReplayedError(id);
      if (parsedTombstone.state === "claimed") throw new InteractionClaimedError(id);
    }
    let record = parseStoredRecordOrCorrupt(raw);
    if (ownership && !ownershipMatches(record, ownership)) throw new InteractionOwnershipError(id);
    if (record.state !== "consumed" && record.state !== "expired") {
      await redis.eval(MARK_EXPIRED_SCRIPT, 2, key, interactionTombstoneKey(id));
      raw = await redis.hgetall(key);
      if (!raw || Object.keys(raw).length === 0) {
        const tombstone = await redis.hgetall(interactionTombstoneKey(id));
        if (Object.keys(tombstone).length > 0) {
          const parsedTombstone = parseTombstoneOrCorrupt(tombstone, id);
          if (ownership && (parsedTombstone.userId !== ownership.userId || parsedTombstone.sessionId !== ownership.sessionId)) throw new InteractionOwnershipError(id);
          if (parsedTombstone.state === "expired" || parsedTombstone.state === "pending") throw new InteractionExpiredError(id);
          if (parsedTombstone.state === "consumed") throw new InteractionReplayedError(id);
          if (parsedTombstone.state === "claimed") throw new InteractionClaimedError(id);
        }
        return null;
      }
      record = parseStoredRecordOrCorrupt(raw);
    }
    return record;
  };

  /**
   * Owner-aware lookup for endpoints that know the authenticated user but do
   * not receive a client session id (for example policy staging). Terminal
   * tombstones keep only a bounded identity marker, so ownership must be
   * established before translating their state into a replay/expiry error.
   * Missing or ownerless tombstones fail closed as ownership errors rather
   * than becoming an interaction-state oracle.
   */
  const getForUser = async (
    id: string,
    userId: string,
    _now: Date = new Date(),
  ): Promise<InteractionRecord | null> => {
    assertIdentity(id, "interaction id");
    assertIdentity(userId, "userId");
    const key = interactionKey(id);
    let raw = await redis.hgetall(key);
    const raiseTombstoneState = (state: InteractionState): never => {
      if (state === "expired" || state === "pending") throw new InteractionExpiredError(id);
      if (state === "consumed") throw new InteractionReplayedError(id);
      if (state === "claimed") throw new InteractionClaimedError(id);
      throw new InteractionTypeError(`stored interaction ${id} has an invalid tombstone state`);
    };
    const readOwnedTombstone = async (): Promise<InteractionRecord | null> => {
      const tombstone = await redis.hgetall(interactionTombstoneKey(id));
      if (!tombstone || Object.keys(tombstone).length === 0) return null;
      const parsed = parseTombstoneOrCorrupt(tombstone, id);
      if (parsed.userId !== userId) throw new InteractionOwnershipError(id);
      return raiseTombstoneState(parsed.state);
    };

    if (!raw || Object.keys(raw).length === 0) return readOwnedTombstone();
    let record = parseStoredRecordOrCorrupt(raw);
    if (record.userId !== userId) throw new InteractionOwnershipError(id);
    if (record.state !== "consumed" && record.state !== "expired") {
      await redis.eval(MARK_EXPIRED_SCRIPT, 2, key, interactionTombstoneKey(id));
      raw = await redis.hgetall(key);
      if (!raw || Object.keys(raw).length === 0) return readOwnedTombstone();
      record = parseStoredRecordOrCorrupt(raw);
      if (record.userId !== userId) throw new InteractionOwnershipError(id);
    }
    return record;
  };

  const put = async (input: InteractionPutInput): Promise<InteractionRecord> => {
    const request = parseAgentInteractionRequest(input.request);
    const continuation = parseAgentContinuation(input.continuation);
    const recipe = parseChatAgentRecipe(input.recipe);
    assertIdentity(input.sourceStreamId, "sourceStreamId");
    assertIdentity(input.ownership.userId, "userId");
    assertIdentity(input.ownership.sessionId, "sessionId");
    if (request.id !== continuation.interaction.id || request.type !== continuation.interaction.type) {
      throw new InteractionTypeError("request and continuation do not match");
    }
    if (boundedJson(request, "request") !== boundedJson(continuation.interaction, "continuation interaction")) {
      throw new InteractionTypeError("request and continuation interaction payloads do not match");
    }
    if (continuation.agentId !== CHAT_AGENT_ID || recipe.agentId !== CHAT_AGENT_ID || continuation.agentId !== recipe.agentId) {
      throw new InteractionTypeError("interaction agent does not match the chat recipe");
    }
    if (continuation.sourceRunId !== (input.sourceRunId ?? continuation.sourceRunId)) {
      throw new InteractionTypeError("source run does not match continuation");
    }
    assertRecipeIdentity(recipe, input.ownership);
    const ttlSeconds = input.ttlSeconds ?? defaultTtlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > INTERACTION_MAX_TTL_SECONDS) {
      throw new InteractionTypeError("interaction TTL is outside the allowed bound");
    }
    const now = input.now ?? new Date();
    const sourceRunId = input.sourceRunId ?? continuation.sourceRunId;
    const fingerprint = interactionFingerprint({
      id: request.id,
      userId: input.ownership.userId,
      sessionId: input.ownership.sessionId,
      sourceStreamId: input.sourceStreamId,
      sourceRunId,
      request,
      continuation,
      recipe,
    });
    const key = interactionKey(request.id);
    const result = String(await redis.eval(
      PUT_SCRIPT,
      2,
      key,
      interactionTombstoneKey(request.id),
      request.id,
      input.ownership.userId,
      input.ownership.sessionId,
      input.sourceStreamId,
      sourceRunId,
      boundedJson(request, "request"),
      boundedJson(continuation, "continuation"),
      boundedJson(recipe, "recipe"),
      String(ttlSeconds),
      fingerprint,
    ));
    if (result !== "stored" && result !== "same") operationError(request.id, result);
    const stored = await get(request.id, input.ownership, now);
    if (!stored) throw new InteractionNotFoundError(request.id);
    if (stored.state === "expired") throw new InteractionExpiredError(request.id);
    if (stored.state === "consumed") throw new InteractionReplayedError(request.id);
    if (stored.state === "claimed") throw new InteractionClaimedError(request.id);
    return stored;
  };

  const claim = async (id: string, input: InteractionClaimInput): Promise<InteractionClaim> => {
    assertIdentity(id, "interaction id");
    assertIdentity(input.userId, "userId");
    assertIdentity(input.sessionId, "sessionId");
    assertIdentity(input.resumeStreamId, "resumeStreamId");
    let parsedResponse: AgentInteractionResponse;
    try {
      parsedResponse = parseAgentInteractionResponse(input.response);
    } catch (error) {
      throw new InteractionTypeError(error instanceof Error ? error.message : "invalid interaction response");
    }
    const now = input.now ?? new Date();
    const token = input.token ?? randomUUID();
    assertIdentity(token, "claim token");
    const current = await get(id, input, now);
    if (!current) throw new InteractionNotFoundError(id);
    try {
      assertAgentInteractionResponse(current.request, parsedResponse);
    } catch (error) {
      throw new InteractionTypeError(error instanceof Error ? error.message : "invalid interaction response");
    }
    const responseFp = responseFingerprint(parsedResponse);
    const result = String(await redis.eval(
      CLAIM_SCRIPT,
      2,
      interactionKey(id),
      interactionTombstoneKey(id),
      input.userId,
      input.sessionId,
      token,
      input.fingerprint ?? current.fingerprint,
      responseFp,
      input.resumeStreamId,
    ));
    if (result !== "claimed" && result !== "same-claim" && result !== "reclaimed") operationError(id, result);
    const record = await get(id, input, now);
    if (!record) throw new InteractionNotFoundError(id);
    return { record, token };
  };

  const release = async (input: InteractionTokenInput): Promise<InteractionRecord> => {
    assertIdentity(input.id, "interaction id");
    const now = new Date();
    const result = String(await redis.eval(
      RELEASE_SCRIPT,
      2,
      interactionKey(input.id),
      interactionTombstoneKey(input.id),
      input.userId,
      input.sessionId,
      input.token,
    ));
    if (result !== "released" && result !== "lease-expired") operationError(input.id, result);
    const record = await get(input.id, input, now);
    if (!record) throw new InteractionNotFoundError(input.id);
    return record;
  };

  const consume = async (input: InteractionConsumeInput): Promise<InteractionRecord> => {
    assertIdentity(input.id, "interaction id");
    assertIdentity(input.jobId, "jobId");
    assertIdentity(input.resumeStreamId, "resumeStreamId");
    let response: AgentInteractionResponse;
    let existing: InteractionRecord;
    try {
      response = parseAgentInteractionResponse(input.response);
      existing = await get(input.id, input) as InteractionRecord;
      if (!existing) throw new InteractionNotFoundError(input.id);
      assertAgentInteractionResponse(existing.request, response);
    } catch (error) {
      if (error instanceof InteractionStoreError) throw error;
      throw new InteractionTypeError(error instanceof Error ? error.message : "invalid interaction response");
    }
    const responseFp = responseFingerprint(response);
    const result = String(await redis.eval(
      CONSUME_SCRIPT,
      2,
      interactionKey(input.id),
      interactionTombstoneKey(input.id),
      input.userId,
      input.sessionId,
      input.token ?? "",
      boundedJson(response, "response"),
      existing.fingerprint,
      responseFp,
      input.jobId,
      input.resumeStreamId,
    ));
    if (result !== "consumed" && result !== "already-consumed") operationError(input.id, result);
    const record = await get(input.id, input);
    if (!record) throw new InteractionNotFoundError(input.id);
    return record;
  };

  const onInteraction = async (
    outcome: AgentInteractionOutcome,
    recipe: ChatAgentRecipe,
    ownership: InteractionPersistenceOwnership,
  ): Promise<InteractionRecord> => {
    if (outcome.type !== "interaction") throw new InteractionTypeError("only interaction outcomes can be persisted");
    const request = parseAgentInteractionRequest(outcome.interaction);
    const continuation = parseAgentContinuation(outcome.continuation);
    if (outcome.runId !== continuation.sourceRunId) {
      throw new InteractionTypeError("outcome run id does not match continuation source run");
    }
    return put({
      request,
      continuation,
      recipe,
      sourceRunId: outcome.runId,
      sourceStreamId: ownership.sourceStreamId,
      ownership,
    });
  };

  return { get, getForUser, put, claim, release, consume, onInteraction };
}

export type InteractionStore = ReturnType<typeof createInteractionStore>;

export function createInteractionPersistenceCallback(input: {
  store: InteractionStore;
  recipe: ChatAgentRecipe;
  ownership: InteractionPersistenceOwnership;
}): (outcome: AgentInteractionOutcome) => Promise<void> {
  return async (outcome) => {
    await input.store.onInteraction(outcome, input.recipe, input.ownership);
  };
}

let store: InteractionStore | null = null;

export function getInteractionStore(): InteractionStore {
  if (!store) store = createInteractionStore(getRedis() as unknown as Redis);
  return store;
}
