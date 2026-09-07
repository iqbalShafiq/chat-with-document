import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import {
  parseAgentInteractionResponse,
  type AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import { getRedis } from "../../lib/redis.js";

export const INTERACTION_POLICY_SCHEMA_VERSION = "interaction-policy-v1" as const;
export const INTERACTION_POLICY_DEFAULT_TTL_SECONDS = 5 * 60;
export const INTERACTION_POLICY_MAX_TTL_SECONDS = 24 * 60 * 60;
export const INTERACTION_POLICY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_SERIALIZED_BYTES = 64 * 1024;

const policyDigest = (interactionId: string): string =>
  createHash("sha256").update(interactionId).digest("hex");

/**
 * Interaction ids are intentionally never used as Redis key material. The
 * hash tag keeps the single-key Lua transitions cluster-safe while keeping
 * prompt/tool input out of operational key listings.
 */
export const interactionPolicyKey = (interactionId: string): string =>
  `chat-interaction-policy:{${policyDigest(interactionId)}}`;

export type InteractionPolicyState = "staged" | "claimed" | "consumed" | "expired";

export type InteractionPolicyRecord = {
  schemaVersion: typeof INTERACTION_POLICY_SCHEMA_VERSION;
  interactionId: string;
  userId: string;
  sessionId: string;
  toolName: string;
  responseFingerprint: string;
  grantScope?: "session";
  overrideArgs?: Record<string, unknown>;
  state: InteractionPolicyState;
  stagedAt: string;
  updatedAt: string;
  expiresAt: string;
  consumedAt?: string;
  claimToken?: string;
  claimExpiresAt?: string;
};

export type InteractionPolicyStageInput = {
  interactionId: string;
  userId: string;
  sessionId: string;
  toolName: string;
  /** SHA-256 of the canonical Anvia response. The response itself is not persisted. */
  responseFingerprint: string;
  grantScope?: "session";
  overrideArgs?: Record<string, unknown>;
  ttlSeconds?: number;
};

export type InteractionPolicyClaimBinding = {
  interactionId: string;
  userId: string;
  sessionId: string;
  toolName: string;
  /** Must be the fingerprint of the response that caused this continuation. */
  responseFingerprint: string;
};

export type InteractionPolicyClaimInput = InteractionPolicyClaimBinding & {
  claimToken: string;
  leaseSeconds?: number;
};

export type InteractionPolicyClaimResult = {
  state: "claimed";
  interactionId: string;
  userId: string;
  sessionId: string;
  toolName: string;
  responseFingerprint: string;
  claimToken: string;
  claimExpiresAt: string;
  grantScope?: "session";
  overrideArgs?: Record<string, unknown>;
};

/** Narrow contract keeps storage tests honest and allows a worker seam. */
export type InteractionPolicyRedis = {
  eval: (script: string, keyCount: number, ...keysAndArgs: string[]) => Promise<unknown>;
  hgetall: (key: string) => Promise<Record<string, string>>;
};

export class InteractionPolicyStoreError extends Error {
  constructor(
    message: string,
    public code:
      | "not_found"
      | "ownership"
      | "conflict"
      | "replayed"
      | "expired"
      | "type"
      | "corrupt"
      | "unavailable",
  ) {
    super(message);
    this.name = "InteractionPolicyStoreError";
  }
}

export class InteractionPolicyOwnershipError extends InteractionPolicyStoreError {
  constructor(id: string) {
    super(`interaction policy ${id} is not owned by this user and session`, "ownership");
    this.name = "InteractionPolicyOwnershipError";
  }
}

export class InteractionPolicyConflictError extends InteractionPolicyStoreError {
  constructor(message: string) {
    super(message, "conflict");
    this.name = "InteractionPolicyConflictError";
  }
}

export class InteractionPolicyReplayError extends InteractionPolicyStoreError {
  constructor(id: string) {
    super(`interaction policy ${id} has already been consumed`, "replayed");
    this.name = "InteractionPolicyReplayError";
  }
}

export class InteractionPolicyExpiredError extends InteractionPolicyStoreError {
  constructor(id: string) {
    super(`interaction policy ${id} has expired`, "expired");
    this.name = "InteractionPolicyExpiredError";
  }
}

export class InteractionPolicyTypeError extends InteractionPolicyStoreError {
  constructor(message: string) {
    super(message, "type");
    this.name = "InteractionPolicyTypeError";
  }
}

export class InteractionPolicyCorruptError extends InteractionPolicyTypeError {
  constructor(message: string) {
    super(message);
    this.name = "InteractionPolicyCorruptError";
    this.code = "corrupt";
  }
}

export class InteractionPolicyUnavailableError extends InteractionPolicyStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, "unavailable");
    this.name = "InteractionPolicyUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

const LUA_POLICY_INVARIANTS = `
local function validatePolicy(expectedId)
  local allowed = {
    schemaVersion=true, id=true, userId=true, sessionId=true, toolName=true,
    responseFingerprint=true, grantScope=true, overrideArgs=true, state=true,
    stagedAt=true, updatedAt=true, expiresAt=true, consumedAt=true,
    claimToken=true, claimExpiresAt=true
  }
  for _, field in ipairs(redis.call("HKEYS", KEYS[1])) do
    if not allowed[field] then return "corrupt" end
  end
  if redis.call("HGET", KEYS[1], "schemaVersion") ~= "${INTERACTION_POLICY_SCHEMA_VERSION}" then return "corrupt" end
  if redis.call("HGET", KEYS[1], "id") ~= expectedId then return "corrupt" end
  for _, field in ipairs({"userId", "sessionId", "toolName"}) do
    local value = redis.call("HGET", KEYS[1], field)
    if not value or value == "" or string.len(value) > 256 then return "corrupt" end
  end
  local fingerprint = redis.call("HGET", KEYS[1], "responseFingerprint")
  if not fingerprint or string.len(fingerprint) ~= 64 or not string.match(fingerprint, "^[a-f0-9]+$") then return "corrupt" end
  for _, field in ipairs({"stagedAt", "updatedAt", "expiresAt"}) do
    local value = tonumber(redis.call("HGET", KEYS[1], field) or "0")
    if not value or value <= 0 then return "corrupt" end
  end
  local grant = redis.call("HGET", KEYS[1], "grantScope")
  if grant and grant ~= "session" then return "corrupt" end
  local overrideRaw = redis.call("HGET", KEYS[1], "overrideArgs")
  if overrideRaw then
    if string.sub(overrideRaw, 1, 1) ~= "{" then return "corrupt" end
    local ok, decoded = pcall(cjson.decode, overrideRaw)
    if not ok or type(decoded) ~= "table" then return "corrupt" end
  end
  local state = redis.call("HGET", KEYS[1], "state")
  local claimToken = redis.call("HGET", KEYS[1], "claimToken")
  local claimExpiresAt = redis.call("HGET", KEYS[1], "claimExpiresAt")
  local consumedAt = redis.call("HGET", KEYS[1], "consumedAt")
  if state == "staged" then
    if claimToken or claimExpiresAt or consumedAt then return "corrupt" end
  elseif state == "claimed" then
    if not claimToken or claimToken == "" or string.len(claimToken) > 256 then return "corrupt" end
    if not claimExpiresAt or tonumber(claimExpiresAt) == nil or tonumber(claimExpiresAt) <= 0 or consumedAt then return "corrupt" end
  elseif state == "consumed" then
    if not consumedAt or tonumber(consumedAt) == nil or tonumber(consumedAt) <= 0 then return "corrupt" end
    if grant or overrideRaw or claimToken or claimExpiresAt then return "corrupt" end
  elseif state == "expired" then
    if grant or overrideRaw or claimToken or claimExpiresAt or consumedAt then return "corrupt" end
  else
    return "corrupt"
  end
  return nil
end`;

const STAGE_SCRIPT = `-- interaction-policy-store:stage
${LUA_POLICY_INVARIANTS}
local state = redis.call("HGET", KEYS[1], "state")
if not state then
  local partialFields = redis.call("HKEYS", KEYS[1])
  if #partialFields > 0 then return "corrupt" end
end
if state then
  local invariantError = validatePolicy(ARGV[1])
  if invariantError then return invariantError end
  if redis.call("HGET", KEYS[1], "id") ~= ARGV[1] then return "conflict" end
  if redis.call("HGET", KEYS[1], "userId") ~= ARGV[2] or redis.call("HGET", KEYS[1], "sessionId") ~= ARGV[3] then return "owner" end
  if redis.call("HGET", KEYS[1], "toolName") ~= ARGV[4] or redis.call("HGET", KEYS[1], "responseFingerprint") ~= ARGV[5] then return "conflict" end
if state == "consumed" then return "consumed" end
if state == "expired" then return "expired" end
if state == "claimed" then return "conflict" end
  local serverTime = redis.call("TIME")
  local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
  local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt") or "0")
  if expiresAt > 0 and expiresAt <= nowMs then
    redis.call("HSET", KEYS[1], "state", "expired", "updatedAt", tostring(nowMs))
    redis.call("HDEL", KEYS[1], "grantScope", "overrideArgs")
    redis.call("PEXPIREAT", KEYS[1], tostring(nowMs + ${INTERACTION_POLICY_RETENTION_SECONDS * 1000}))
    return "expired"
  end
  local existingGrant = redis.call("HGET", KEYS[1], "grantScope") or ""
  local existingOverride = redis.call("HGET", KEYS[1], "overrideArgs") or ""
  if existingGrant == ARGV[6] and existingOverride == ARGV[7] then return "same" end
  return "conflict"
end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local expiresMs = nowMs + tonumber(ARGV[8]) * 1000
redis.call("HSET", KEYS[1],
  "schemaVersion", "${INTERACTION_POLICY_SCHEMA_VERSION}",
  "id", ARGV[1], "userId", ARGV[2], "sessionId", ARGV[3],
  "toolName", ARGV[4], "responseFingerprint", ARGV[5],
  "state", "staged", "stagedAt", tostring(nowMs), "updatedAt", tostring(nowMs),
  "expiresAt", tostring(expiresMs))
if ARGV[6] ~= "" then redis.call("HSET", KEYS[1], "grantScope", ARGV[6]) end
if ARGV[7] ~= "" then redis.call("HSET", KEYS[1], "overrideArgs", ARGV[7]) end
redis.call("PEXPIREAT", KEYS[1], tostring(expiresMs + ${INTERACTION_POLICY_RETENTION_SECONDS * 1000}))
return "stored"`;

const CLAIM_SCRIPT = `-- interaction-policy-store:claim
${LUA_POLICY_INVARIANTS}
local state = redis.call("HGET", KEYS[1], "state")
if not state then
  if #redis.call("HKEYS", KEYS[1]) > 0 then return "corrupt" end
  return "missing"
end
local invariantError = validatePolicy(ARGV[1])
if invariantError then return invariantError end
if redis.call("HGET", KEYS[1], "id") ~= ARGV[1] then return "conflict" end
if redis.call("HGET", KEYS[1], "userId") ~= ARGV[2] or redis.call("HGET", KEYS[1], "sessionId") ~= ARGV[3] then return "owner" end
if redis.call("HGET", KEYS[1], "toolName") ~= ARGV[4] or redis.call("HGET", KEYS[1], "responseFingerprint") ~= ARGV[5] then return "conflict" end
if state == "consumed" then return "replayed" end
if state == "expired" then return "expired" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt") or "0")
if expiresAt <= nowMs then redis.call("HSET", KEYS[1], "state", "expired", "updatedAt", tostring(nowMs)); redis.call("HDEL", KEYS[1], "grantScope", "overrideArgs", "claimToken", "claimExpiresAt"); return "expired" end
if state == "claimed" then
  local oldExpiry = tonumber(redis.call("HGET", KEYS[1], "claimExpiresAt") or "0")
  if oldExpiry > nowMs and redis.call("HGET", KEYS[1], "claimToken") ~= ARGV[6] then return "claimed" end
end
local claimExpires = nowMs + tonumber(ARGV[7]) * 1000
redis.call("HSET", KEYS[1], "state", "claimed", "claimToken", ARGV[6], "claimExpiresAt", tostring(claimExpires), "updatedAt", tostring(nowMs))
local result = {state="claimed", schemaVersion="${INTERACTION_POLICY_SCHEMA_VERSION}", interactionId=ARGV[1], userId=ARGV[2], sessionId=ARGV[3], toolName=ARGV[4], responseFingerprint=ARGV[5], claimToken=ARGV[6], claimExpiresAt=tostring(claimExpires)}
local grant = redis.call("HGET", KEYS[1], "grantScope") or ""
local overrideRaw = redis.call("HGET", KEYS[1], "overrideArgs") or ""
if grant ~= "" then result.grantScope = grant end
if overrideRaw ~= "" then
  local ok, decoded = pcall(cjson.decode, overrideRaw)
  if not ok or type(decoded) ~= "table" or decoded[1] ~= nil then return "corrupt" end
  result.overrideArgs = decoded
end
return cjson.encode(result)`;

const CONSUME_SCRIPT = `-- interaction-policy-store:consume
${LUA_POLICY_INVARIANTS}
local state = redis.call("HGET", KEYS[1], "state")
if not state then
  if #redis.call("HKEYS", KEYS[1]) > 0 then return "corrupt" end
  return "missing"
end
local invariantError = validatePolicy(ARGV[1])
if invariantError then return invariantError end
if redis.call("HGET", KEYS[1], "id") ~= ARGV[1] then return "conflict" end
if redis.call("HGET", KEYS[1], "userId") ~= ARGV[2] or redis.call("HGET", KEYS[1], "sessionId") ~= ARGV[3] then return "owner" end
if redis.call("HGET", KEYS[1], "toolName") ~= ARGV[4] or redis.call("HGET", KEYS[1], "responseFingerprint") ~= ARGV[5] then return "conflict" end
if state == "consumed" then return "replayed" end
if state == "expired" then return "expired" end
if redis.call("HGET", KEYS[1], "claimToken") ~= ARGV[6] then return "claim" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
redis.call("HSET", KEYS[1], "state", "consumed", "updatedAt", tostring(nowMs), "consumedAt", tostring(nowMs))
redis.call("HDEL", KEYS[1], "grantScope", "overrideArgs", "claimToken", "claimExpiresAt")
return "consumed"`;

const RELEASE_SCRIPT = `-- interaction-policy-store:release
${LUA_POLICY_INVARIANTS}
local state = redis.call("HGET", KEYS[1], "state")
if not state then
  if #redis.call("HKEYS", KEYS[1]) > 0 then return "corrupt" end
  return "missing"
end
local invariantError = validatePolicy(ARGV[2])
if invariantError then return invariantError end
if state ~= "claimed" then return state end
if redis.call("HGET", KEYS[1], "claimToken") ~= ARGV[1] then return "claim" end
local serverTime = redis.call("TIME")
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
redis.call("HSET", KEYS[1], "state", "staged", "updatedAt", tostring(nowMs))
redis.call("HDEL", KEYS[1], "claimToken", "claimExpiresAt")
return "released"`;

function assertIdentity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new InteractionPolicyTypeError(`${field} must be a nonblank bounded string`);
  }
}

function assertFingerprint(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new InteractionPolicyTypeError(`${field} must be a SHA-256 fingerprint`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function encodeOverride(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractionPolicyTypeError("overrideArgs must be a JSON object");
  }
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new InteractionPolicyTypeError("overrideArgs exceeds the serialized size bound");
  }
  return encoded;
}

function parseTimestamp(raw: string, field: string): string {
  const milliseconds = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new InteractionPolicyCorruptError(`stored ${field} timestamp is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

function parseStoredRecord(raw: Record<string, string>): InteractionPolicyRecord {
  const allowed = new Set([
    "schemaVersion",
    "id",
    "userId",
    "sessionId",
    "toolName",
    "responseFingerprint",
    "grantScope",
    "overrideArgs",
    "state",
    "stagedAt",
    "updatedAt",
    "expiresAt",
    "consumedAt",
    "claimToken",
    "claimExpiresAt",
  ]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new InteractionPolicyCorruptError(`stored interaction policy has unknown fields: ${unknown.join(",")}`);
  }
  const id = raw.id ?? "";
  assertIdentity(id, "interactionId");
  if (raw.schemaVersion !== INTERACTION_POLICY_SCHEMA_VERSION) {
    throw new InteractionPolicyCorruptError(`stored interaction policy ${id} has an unsupported schema version`);
  }
  if (raw.userId === undefined || raw.sessionId === undefined || raw.toolName === undefined) {
    throw new InteractionPolicyCorruptError(`stored interaction policy ${id} is missing ownership or tool identity`);
  }
  assertIdentity(raw.userId, "userId");
  assertIdentity(raw.sessionId, "sessionId");
  assertIdentity(raw.toolName, "toolName");
  assertFingerprint(raw.responseFingerprint, "responseFingerprint");
  if (raw.grantScope !== undefined && raw.grantScope !== "session") {
    throw new InteractionPolicyCorruptError(`stored interaction policy ${id} has an invalid grant scope`);
  }
  let overrideArgs: Record<string, unknown> | undefined;
  if (raw.overrideArgs !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw.overrideArgs);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      if (Buffer.byteLength(JSON.stringify(canonicalize(parsed)), "utf8") > MAX_SERIALIZED_BYTES) {
        throw new Error("too large");
      }
      overrideArgs = parsed as Record<string, unknown>;
    } catch {
      throw new InteractionPolicyCorruptError(`stored interaction policy ${id} has invalid overrideArgs`);
    }
  }
  if (raw.state !== "staged" && raw.state !== "claimed" && raw.state !== "consumed" && raw.state !== "expired") {
    throw new InteractionPolicyCorruptError(`stored interaction policy ${id} has an invalid state`);
  }
  if (raw.state === "consumed" || raw.state === "expired") {
    if (raw.grantScope !== undefined || raw.overrideArgs !== undefined || raw.claimToken !== undefined || raw.claimExpiresAt !== undefined) {
      throw new InteractionPolicyCorruptError(`stored interaction policy ${id} retains executable fields after terminal state`);
    }
  }
  if (raw.state !== "claimed" && (raw.claimToken !== undefined || raw.claimExpiresAt !== undefined)) {
    throw new InteractionPolicyCorruptError(`stored interaction policy ${id} has claim fields outside claimed state`);
  }
  if (raw.state === "consumed" && raw.consumedAt === undefined) {
    throw new InteractionPolicyCorruptError(`stored interaction policy ${id} is missing consumedAt`);
  }
  if (raw.state === "claimed") {
    assertIdentity(raw.claimToken ?? "", "claimToken");
    parseTimestamp(raw.claimExpiresAt ?? "", "claimExpiresAt");
  }
  if (raw.state !== "consumed" && raw.consumedAt !== undefined) {
    throw new InteractionPolicyCorruptError(`stored interaction policy ${id} has consumedAt before consumption`);
  }
  return {
    schemaVersion: INTERACTION_POLICY_SCHEMA_VERSION,
    interactionId: id,
    userId: raw.userId,
    sessionId: raw.sessionId,
    toolName: raw.toolName,
    responseFingerprint: raw.responseFingerprint,
    ...(raw.grantScope ? { grantScope: raw.grantScope } : {}),
    ...(overrideArgs ? { overrideArgs } : {}),
    state: raw.state,
    stagedAt: parseTimestamp(raw.stagedAt ?? "", "stagedAt"),
    updatedAt: parseTimestamp(raw.updatedAt ?? "", "updatedAt"),
    expiresAt: parseTimestamp(raw.expiresAt ?? "", "expiresAt"),
    ...(raw.consumedAt ? { consumedAt: parseTimestamp(raw.consumedAt, "consumedAt") } : {}),
    ...(raw.claimToken ? { claimToken: raw.claimToken } : {}),
    ...(raw.claimExpiresAt ? { claimExpiresAt: parseTimestamp(raw.claimExpiresAt, "claimExpiresAt") } : {}),
  };
}

function parseClaimed(raw: string, input: InteractionPolicyClaimInput): InteractionPolicyClaimResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new InteractionPolicyCorruptError("claimed interaction policy is not valid JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InteractionPolicyCorruptError("claimed interaction policy is invalid");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "state",
    "schemaVersion",
    "interactionId",
    "userId",
    "sessionId",
    "toolName",
    "responseFingerprint",
    "claimToken",
    "claimExpiresAt",
    "grantScope",
    "overrideArgs",
  ]);
  const unknown = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new InteractionPolicyCorruptError(`claimed interaction policy has unknown fields: ${unknown.join(",")}`);
  if (record.schemaVersion !== INTERACTION_POLICY_SCHEMA_VERSION || record.state !== "claimed" || record.claimToken !== input.claimToken || typeof record.claimExpiresAt !== "string") throw new InteractionPolicyCorruptError("claimed interaction policy binding is invalid");
  for (const [field, expected] of Object.entries({ interactionId: input.interactionId, userId: input.userId, sessionId: input.sessionId, toolName: input.toolName })) {
    if (record[field] !== expected) throw new InteractionPolicyCorruptError("claimed interaction policy identity is invalid");
  }
  assertFingerprint(record.responseFingerprint, "responseFingerprint");
  if (record.responseFingerprint !== input.responseFingerprint) throw new InteractionPolicyCorruptError("claimed interaction policy response binding is invalid");
  assertIdentity(record.claimToken as string, "claimToken");
  parseTimestamp(record.claimExpiresAt, "claimExpiresAt");
  if (record.grantScope !== undefined && record.grantScope !== "session") throw new InteractionPolicyCorruptError("claimed interaction policy grant scope is invalid");
  if (record.overrideArgs !== undefined) {
    try {
      encodeOverride(record.overrideArgs);
    } catch {
      throw new InteractionPolicyCorruptError("claimed interaction policy override is invalid");
    }
  }
  return { state: "claimed", interactionId: input.interactionId, userId: input.userId, sessionId: input.sessionId, toolName: input.toolName, responseFingerprint: input.responseFingerprint, claimToken: input.claimToken, claimExpiresAt: record.claimExpiresAt, ...(record.grantScope ? { grantScope: "session" as const } : {}), ...(record.overrideArgs ? { overrideArgs: record.overrideArgs as Record<string, unknown> } : {}) };
}

function wrapUnavailable(error: unknown): InteractionPolicyUnavailableError {
  return new InteractionPolicyUnavailableError("interaction policy store is unavailable", error);
}

/** Canonical native response fingerprint; only the digest crosses the policy boundary. */
export function interactionResponseFingerprint(response: AgentInteractionResponse | unknown): string {
  let parsed: AgentInteractionResponse;
  try {
    parsed = parseAgentInteractionResponse(response);
  } catch (error) {
    throw new InteractionPolicyTypeError(error instanceof Error ? error.message : "invalid interaction response");
  }
  const encoded = JSON.stringify(canonicalize(parsed));
  if (encoded === undefined) throw new InteractionPolicyTypeError("interaction response is not serializable");
  return createHash("sha256").update(encoded).digest("hex");
}

export function createInteractionPolicyStore(
  redis: InteractionPolicyRedis,
  options: { ttlSeconds?: number } = {},
) {
  const defaultTtlSeconds = options.ttlSeconds ?? INTERACTION_POLICY_DEFAULT_TTL_SECONDS;

  const get = async (interactionId: string): Promise<InteractionPolicyRecord | null> => {
    assertIdentity(interactionId, "interactionId");
    let raw: Record<string, string>;
    try {
      raw = await redis.hgetall(interactionPolicyKey(interactionId));
    } catch (error) {
      throw wrapUnavailable(error);
    }
    if (!raw || Object.keys(raw).length === 0) return null;
    let record: InteractionPolicyRecord;
    try {
      record = parseStoredRecord(raw);
    } catch (error) {
      if (error instanceof InteractionPolicyCorruptError) throw error;
      throw new InteractionPolicyCorruptError(
        error instanceof Error ? error.message : "stored interaction policy is corrupt",
      );
    }
    if (record.interactionId !== interactionId) {
      throw new InteractionPolicyCorruptError("stored interaction policy id does not match its key");
    }
    return record;
  };

  const stage = async (input: InteractionPolicyStageInput): Promise<InteractionPolicyRecord> => {
    assertIdentity(input.interactionId, "interactionId");
    assertIdentity(input.userId, "userId");
    assertIdentity(input.sessionId, "sessionId");
    assertIdentity(input.toolName, "toolName");
    assertFingerprint(input.responseFingerprint, "responseFingerprint");
    const ttlSeconds = input.ttlSeconds ?? defaultTtlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > INTERACTION_POLICY_MAX_TTL_SECONDS) {
      throw new InteractionPolicyTypeError("interaction policy TTL is outside the allowed bound");
    }
    if (input.grantScope !== undefined && input.grantScope !== "session") {
      throw new InteractionPolicyTypeError("grantScope must be session");
    }
    const overrideJson = encodeOverride(input.overrideArgs);
    // Validate an existing record before the Lua transition. This prevents a
    // malformed hash from becoming executable policy through an idempotent
    // retry, while the script remains the atomic ownership/idempotency gate.
    await get(input.interactionId);
    let result: string;
    try {
      result = String(await redis.eval(
        STAGE_SCRIPT,
        1,
        interactionPolicyKey(input.interactionId),
        input.interactionId,
        input.userId,
        input.sessionId,
        input.toolName,
        input.responseFingerprint,
        input.grantScope ?? "",
        overrideJson ?? "",
        String(ttlSeconds),
      ));
    } catch (error) {
      throw wrapUnavailable(error);
    }
    switch (result) {
      case "stored":
      case "same": {
        const record = await get(input.interactionId);
        if (!record) throw new InteractionPolicyStoreError("interaction policy disappeared after stage", "not_found");
        if (record.state === "expired") throw new InteractionPolicyExpiredError(input.interactionId);
        if (record.state === "consumed") throw new InteractionPolicyReplayError(input.interactionId);
        return record;
      }
      case "owner":
        throw new InteractionPolicyOwnershipError(input.interactionId);
      case "consumed":
        throw new InteractionPolicyReplayError(input.interactionId);
      case "expired":
        throw new InteractionPolicyExpiredError(input.interactionId);
      case "claimed":
        throw new InteractionPolicyConflictError(`interaction policy ${input.interactionId} is already claimed`);
      case "corrupt":
        throw new InteractionPolicyCorruptError("stored interaction policy is corrupt");
      case "conflict":
      default:
        throw new InteractionPolicyConflictError(`interaction policy ${input.interactionId} conflicts with an existing stage`);
    }
  };

  const claim = async (input: InteractionPolicyClaimInput): Promise<InteractionPolicyClaimResult> => {
    assertIdentity(input.claimToken, "claimToken");
    const leaseSeconds = input.leaseSeconds ?? 120;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) throw new InteractionPolicyTypeError("policy claim lease is outside the allowed bound");
    assertIdentity(input.interactionId, "interactionId");
    assertIdentity(input.userId, "userId");
    assertIdentity(input.sessionId, "sessionId");
    assertIdentity(input.toolName, "toolName");
    assertFingerprint(input.responseFingerprint, "responseFingerprint");
    let result: string;
    try {
      result = String(await redis.eval(CLAIM_SCRIPT, 1, interactionPolicyKey(input.interactionId), input.interactionId, input.userId, input.sessionId, input.toolName, input.responseFingerprint, input.claimToken, String(leaseSeconds)));
    } catch (error) { throw wrapUnavailable(error); }
    switch (result) {
      case "missing": throw new InteractionPolicyStoreError("interaction policy was not found", "not_found");
      case "owner": throw new InteractionPolicyOwnershipError(input.interactionId);
      case "conflict": throw new InteractionPolicyConflictError("interaction policy binding does not match");
      case "claimed": throw new InteractionPolicyConflictError("interaction policy is already claimed");
      case "replayed": throw new InteractionPolicyReplayError(input.interactionId);
      case "expired": throw new InteractionPolicyExpiredError(input.interactionId);
      case "corrupt": throw new InteractionPolicyCorruptError("stored interaction policy is corrupt");
      default: return parseClaimed(result, input);
    }
  };

  const consume = async (input: InteractionPolicyClaimInput): Promise<void> => {
    assertIdentity(input.claimToken, "claimToken");
    let result: string;
    try { result = String(await redis.eval(CONSUME_SCRIPT, 1, interactionPolicyKey(input.interactionId), input.interactionId, input.userId, input.sessionId, input.toolName, input.responseFingerprint, input.claimToken)); } catch (error) { throw wrapUnavailable(error); }
    switch (result) {
      case "consumed": return;
      case "missing": throw new InteractionPolicyStoreError("interaction policy was not found", "not_found");
      case "owner": throw new InteractionPolicyOwnershipError(input.interactionId);
      case "conflict": throw new InteractionPolicyConflictError("interaction policy binding does not match");
      case "claim": throw new InteractionPolicyConflictError("interaction policy claim does not match");
      case "replayed": throw new InteractionPolicyReplayError(input.interactionId);
      case "expired": throw new InteractionPolicyExpiredError(input.interactionId);
      default: throw new InteractionPolicyCorruptError("stored interaction policy has an invalid state");
    }
  };

  const release = async (input: Pick<InteractionPolicyClaimInput, "interactionId" | "claimToken">): Promise<void> => {
    assertIdentity(input.claimToken, "claimToken");
    let result: string;
    try { result = String(await redis.eval(RELEASE_SCRIPT, 1, interactionPolicyKey(input.interactionId), input.claimToken, input.interactionId)); } catch (error) { throw wrapUnavailable(error); }
    if (result === "released" || result === "staged") return;
    if (result === "missing") throw new InteractionPolicyStoreError("interaction policy was not found", "not_found");
    if (result === "claim") throw new InteractionPolicyConflictError("interaction policy claim does not match");
    if (result === "consumed") throw new InteractionPolicyReplayError(input.interactionId);
    if (result === "expired") throw new InteractionPolicyExpiredError(input.interactionId);
    throw new InteractionPolicyCorruptError("stored interaction policy has an invalid state");
  };

  return { get, stage, claim, consume, release };
}

export type InteractionPolicyStore = ReturnType<typeof createInteractionPolicyStore>;

let store: InteractionPolicyStore | null = null;

export function getInteractionPolicyStore(): InteractionPolicyStore {
  if (!store) store = createInteractionPolicyStore(getRedis() as unknown as Redis);
  return store;
}

/** Crash-safe worker seam: claim keeps staged policy fields until consume. */
export function claimInteractionPolicy(input: InteractionPolicyClaimInput): Promise<InteractionPolicyClaimResult> {
  return getInteractionPolicyStore().claim(input);
}

export function consumeInteractionPolicy(input: InteractionPolicyClaimInput): Promise<void> {
  return getInteractionPolicyStore().consume(input);
}

export function releaseInteractionPolicy(input: Pick<InteractionPolicyClaimInput, "interactionId" | "claimToken">): Promise<void> {
  return getInteractionPolicyStore().release(input);
}
