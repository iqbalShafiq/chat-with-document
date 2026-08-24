import { randomUUID } from "node:crypto";
import {
  isMemoryCompactionMessage,
  type MemoryCompactionMessage,
  type Message,
} from "@anvia/core";
import { PrismaMemoryStore } from "@anvia/memory-prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";
import {
  TruncateTargetNotFoundError,
  truncateSessionMemory,
} from "./truncate-memory.js";

const userId = "anvia-native-memory-integration";
const sessionId = `native-memory-${randomUUID()}`;
const scope = { sessionId, userId };

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] } as Message;
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] } as Message;
}

function summary(compactedMessageCount: number): MemoryCompactionMessage {
  return {
    role: "system",
    content: "Earlier conversation summary.",
    metadata: {
      anvia: {
        memoryCompaction: { version: 1, compactedMessageCount },
      },
    },
  };
}

function store() {
  return new PrismaMemoryStore({
    client: prisma,
    validateMessages: true,
    errorPolicy: "ignore",
  });
}

describe("native Anvia v1 Prisma memory integration", () => {
  let databaseReady = false;

  beforeAll(async () => {
    try {
      await store().validate();
      databaseReady = true;
    } catch (error) {
      throw new Error(
        "Native memory integration requires the configured Postgres service and migrated schema",
        { cause: error },
      );
    }
  });

  afterAll(async () => {
    if (!databaseReady) return;
    await prisma.agentMemorySession.deleteMany({
      where: { scopeKey: createDefaultMemoryScopeKey(sessionId, userId) },
    });
  });

  it("persists a native summary through atomic prefix replacement", async () => {
    const memory = store();
    await memory.clear({ scope });
    await memory.append({
      scope,
      runId: "run-native-1",
      turn: 1,
      messages: [user("first"), assistant("first answer"), user("latest")],
    });

    const snapshot = await memory.compaction!.snapshot({ scope });
    const result = await memory.compaction!.replacePrefix({
      scope,
      revision: snapshot.revision,
      messageCount: 2,
      replacement: summary(2),
      runId: "memory-compaction:run-native-1:1",
    });

    expect(result).toEqual({ status: "committed" });
    const loaded = await memory.load({ scope });
    expect(loaded).toHaveLength(2);
    expect(isMemoryCompactionMessage(loaded[0]!)).toBe(true);
    expect(loaded[1]).toEqual(user("latest"));
  });

  it("rejects a stale replacement without deleting a concurrent turn", async () => {
    const first = store();
    const second = store();
    await first.clear({ scope });
    await first.append({
      scope,
      runId: "run-native-2",
      turn: 1,
      messages: [user("first"), assistant("first answer"), user("latest")],
    });

    const stale = await first.compaction!.snapshot({ scope });
    const committed = await second.compaction!.replacePrefix({
      scope,
      revision: stale.revision,
      messageCount: 2,
      replacement: summary(2),
      runId: "memory-compaction:run-native-2:1",
    });
    expect(committed).toEqual({ status: "committed" });

    await first.append({
      scope,
      runId: "run-native-3",
      turn: 2,
      messages: [assistant("concurrent answer")],
    });
    const staleResult = await first.compaction!.replacePrefix({
      scope,
      revision: stale.revision,
      messageCount: 2,
      replacement: summary(2),
      runId: "memory-compaction:run-native-2:2",
    });
    expect(staleResult).toEqual({ status: "conflict" });

    const loaded = await first.load({ scope });
    expect(loaded.filter(isMemoryCompactionMessage)).toHaveLength(1);
    expect(loaded.some((message) =>
      message.role === "assistant" &&
      message.content instanceof Array &&
      message.content.some((part) => part.type === "text" && part.text === "concurrent answer"),
    )).toBe(true);
  });

  it("fails closed when a UI position was deleted or reused by native compaction", async () => {
    const memory = store();
    await memory.clear({ scope });
    await memory.append({
      scope,
      runId: "run-native-truncate",
      turn: 1,
      messages: [user("first"), assistant("first answer"), user("latest")],
    });

    const snapshot = await memory.compaction!.snapshot({ scope });
    await memory.compaction!.replacePrefix({
      scope,
      revision: snapshot.revision,
      messageCount: 2,
      replacement: summary(2),
      runId: "memory-compaction:run-native-truncate:1",
    });

    await expect(
      truncateSessionMemory({
        sessionId,
        userId,
        mode: "include",
        memoryPosition: 0,
      }),
    ).rejects.toBeInstanceOf(TruncateTargetNotFoundError);
    await expect(
      truncateSessionMemory({
        sessionId,
        userId,
        mode: "include",
        memoryPosition: 1,
      }),
    ).rejects.toBeInstanceOf(TruncateTargetNotFoundError);

    const loaded = await memory.load({ scope });
    expect(loaded.filter(isMemoryCompactionMessage)).toHaveLength(1);
    expect(loaded).toHaveLength(2);
  });
});
