import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { getRedis } from "../../lib/redis.js";

/** Session grants and one-shot argument overrides remain app-owned policy. */
export const GRANT_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const OVERRIDE_TTL_SECONDS = 5 * 60;

const policyDigest = (sessionId: string, toolName: string) =>
  createHash("sha256").update(JSON.stringify([sessionId, toolName])).digest("hex");
const GRANT_KEY = (sessionId: string, toolName: string) =>
  `chat-tool-grant:${policyDigest(sessionId, toolName)}`;
const OVERRIDE_KEY = (sessionId: string, toolName: string) =>
  `chat-tool-override:${policyDigest(sessionId, toolName)}`;

export type ApprovalRedis = Pick<Redis, "get" | "getdel" | "set" | "del">;

function assertBounded(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error(`${name} must be a nonblank bounded string`);
  }
}
export function createApprovalRegistry(redis: ApprovalRedis) {
  return {
    /** Make "Allow for session" sticky until the grant expires. */
    async grantTool(input: { sessionId: string; toolName: string }): Promise<void> {
      assertBounded(input.sessionId, "sessionId");
      assertBounded(input.toolName, "toolName");
      await redis.set(
        GRANT_KEY(input.sessionId, input.toolName),
        JSON.stringify({ grantedAt: new Date().toISOString() }),
        "EX",
        GRANT_SESSION_TTL_SECONDS,
      );
    },

    async hasToolGrant(sessionId: string, toolName: string): Promise<boolean> {
      assertBounded(sessionId, "sessionId");
      assertBounded(toolName, "toolName");
      return (await redis.get(GRANT_KEY(sessionId, toolName))) !== null;
    },

    async revokeToolGrant(sessionId: string, toolName: string): Promise<void> {
      assertBounded(sessionId, "sessionId");
      assertBounded(toolName, "toolName");
      await redis.del(GRANT_KEY(sessionId, toolName));
    },

    /** Stage edited tool args for exactly one subsequent tool execution. */
    async setToolOverride(input: {
      sessionId: string;
      toolName: string;
      args: Record<string, unknown>;
    }): Promise<void> {
      assertBounded(input.sessionId, "sessionId");
      assertBounded(input.toolName, "toolName");
      if (typeof input.args !== "object" || input.args === null || Array.isArray(input.args)) {
        throw new Error("tool override args must be a JSON object");
      }
      const encoded = JSON.stringify(input.args);
      if (encoded === undefined) throw new Error("tool override args must be JSON serializable");
      await redis.set(
        OVERRIDE_KEY(input.sessionId, input.toolName),
        encoded,
        "EX",
        OVERRIDE_TTL_SECONDS,
      );
    },

    /** Atomically consume a staged override; malformed values are discarded. */
    async takeToolOverride(
      sessionId: string,
      toolName: string,
    ): Promise<Record<string, unknown> | null> {
      assertBounded(sessionId, "sessionId");
      assertBounded(toolName, "toolName");
      const raw = await redis.getdel(OVERRIDE_KEY(sessionId, toolName));
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  };
}

let registry: ReturnType<typeof createApprovalRegistry> | null = null;

/** Process-lifetime app policy registry backed by the shared Redis client. */
export function getApprovalRegistry() {
  if (!registry) registry = createApprovalRegistry(getRedis());
  return registry;
}
