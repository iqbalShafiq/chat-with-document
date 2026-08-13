import { describe, expect, it } from "vitest";
import { createSteerSyncService } from "./steer-sync.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

type SteerSyncPrisma = Pick<
  PrismaClient,
  "agentMemorySession" | "agentMemoryMessage"
>;

type Row = { message: unknown };

function createFakePrisma(
  rows: Row[],
  sessionFound = true,
): SteerSyncPrisma {
  return {
    agentMemorySession: {
      async findUnique() {
        return sessionFound ? { id: "memory-session-1" } : null;
      },
    } as unknown as SteerSyncPrisma["agentMemorySession"],
    agentMemoryMessage: {
      async findMany() {
        return rows as never;
      },
    } as unknown as SteerSyncPrisma["agentMemoryMessage"],
  };
}

const userRow = (clientMessageId: string): Row => ({
  message: { role: "user", content: [], metadata: { clientMessageId } },
});

describe("createSteerSyncService.findAppliedClientMessageIds", () => {
  it("returns ids present in user memory rows", async () => {
    const service = createSteerSyncService({
      prisma: createFakePrisma([userRow("a"), userRow("b")]),
    });
    const result = await service.findAppliedClientMessageIds({
      sessionId: "s",
      userId: "u",
      ids: ["a", "b", "c"],
    });
    expect(result.sort()).toEqual(["a", "b"]);
  });

  it("ignores rows without clientMessageId metadata", async () => {
    const service = createSteerSyncService({
      prisma: createFakePrisma([
        { message: { role: "user", content: [], metadata: {} } },
        { message: { role: "user", content: [] } },
        userRow("a"),
      ]),
    });
    const result = await service.findAppliedClientMessageIds({
      sessionId: "s",
      userId: "u",
      ids: ["a"],
    });
    expect(result).toEqual(["a"]);
  });

  it("returns an empty list when the memory session is missing", async () => {
    const service = createSteerSyncService({
      prisma: createFakePrisma([userRow("a")], false),
    });
    const result = await service.findAppliedClientMessageIds({
      sessionId: "s",
      userId: "u",
      ids: ["a"],
    });
    expect(result).toEqual([]);
  });
});
