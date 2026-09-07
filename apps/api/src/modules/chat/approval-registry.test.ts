import { describe, expect, it, vi } from "vitest";
import {
  createApprovalRegistry,
  GRANT_SESSION_TTL_SECONDS,
  OVERRIDE_TTL_SECONDS,
  type ApprovalRedis,
} from "./approval-registry.js";

const SESSION_ID = "session-1";
const TOOL_NAME = "web_search";

function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK" as const;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    }),
  };
}

describe("app-owned approval registry", () => {
  it("persists and revokes a session grant with a bounded TTL", async () => {
    const redis = createFakeRedis();
    const registry = createApprovalRegistry(redis as unknown as ApprovalRedis);
    await expect(registry.hasToolGrant(SESSION_ID, TOOL_NAME)).resolves.toBe(false);
    await registry.grantTool({ sessionId: SESSION_ID, toolName: TOOL_NAME });
    await expect(registry.hasToolGrant(SESSION_ID, TOOL_NAME)).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^chat-tool-grant:[a-f0-9]{64}$/),
      expect.any(String),
      "EX",
      GRANT_SESSION_TTL_SECONDS,
    );
    await registry.revokeToolGrant(SESSION_ID, TOOL_NAME);
    await expect(registry.hasToolGrant(SESSION_ID, TOOL_NAME)).resolves.toBe(false);
  });

  it("stages and atomically consumes one validated tool override", async () => {
    const redis = createFakeRedis();
    const registry = createApprovalRegistry(redis as unknown as ApprovalRedis);
    const args = { query: "Anvia", limit: 5 };
    await registry.setToolOverride({ sessionId: SESSION_ID, toolName: TOOL_NAME, args });
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^chat-tool-override:[a-f0-9]{64}$/),
      JSON.stringify(args),
      "EX",
      OVERRIDE_TTL_SECONDS,
    );
    await expect(registry.takeToolOverride(SESSION_ID, TOOL_NAME)).resolves.toEqual(args);
    await expect(registry.takeToolOverride(SESSION_ID, TOOL_NAME)).resolves.toBeNull();
  });

  it("drops malformed override payloads instead of returning executable input", async () => {
    const redis = createFakeRedis();
    const registry = createApprovalRegistry(redis as unknown as ApprovalRedis);
    await registry.setToolOverride({ sessionId: SESSION_ID, toolName: TOOL_NAME, args: { valid: true } });
    const overrideKey = redis.set.mock.calls.at(-1)?.[0] as string;
    await redis.set(overrideKey, "not-json");
    await expect(registry.takeToolOverride(SESSION_ID, TOOL_NAME)).resolves.toBeNull();
    await redis.set(overrideKey, JSON.stringify(["not", "object"]));
    await expect(registry.takeToolOverride(SESSION_ID, TOOL_NAME)).resolves.toBeNull();
  });

  it("rejects unbounded or non-object staged overrides", async () => {
    const redis = createFakeRedis();
    const registry = createApprovalRegistry(redis as unknown as ApprovalRedis);
    await expect(registry.grantTool({ sessionId: " ", toolName: TOOL_NAME })).rejects.toThrow(/sessionId/);
    await expect(registry.setToolOverride({ sessionId: SESSION_ID, toolName: TOOL_NAME, args: [] as never })).rejects.toThrow(/JSON object/);
  });

  it("does not collide when session and tool identities contain delimiters", async () => {
    const redis = createFakeRedis();
    const registry = createApprovalRegistry(redis as unknown as ApprovalRedis);
    await registry.grantTool({ sessionId: "a", toolName: "b:c" });
    await registry.grantTool({ sessionId: "a:b", toolName: "c" });
    await registry.revokeToolGrant("a", "b:c");
    await expect(registry.hasToolGrant("a", "b:c")).resolves.toBe(false);
    await expect(registry.hasToolGrant("a:b", "c")).resolves.toBe(true);

    await registry.setToolOverride({ sessionId: "a", toolName: "b:c", args: { first: true } });
    await registry.setToolOverride({ sessionId: "a:b", toolName: "c", args: { second: true } });
    await expect(registry.takeToolOverride("a", "b:c")).resolves.toEqual({ first: true });
    await expect(registry.takeToolOverride("a:b", "c")).resolves.toEqual({ second: true });
  });
});
