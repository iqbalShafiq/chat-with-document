import type { Message } from "@anvia/core/completion";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { prisma as prismaClient } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

export const MAX_SYNC_IDS = 50;

export type SteerSyncPrisma = Pick<
  PrismaClient,
  "agentMemorySession" | "agentMemoryMessage"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSteerSyncService(deps: { prisma: SteerSyncPrisma }) {
  return {
    /**
     * Which of `ids` were already persisted as user messages (steered items
     * committed mid-run) — lets a re-joining client purge them from its queue.
     */
    async findAppliedClientMessageIds(input: {
      sessionId: string;
      userId: string;
      ids: string[];
    }): Promise<string[]> {
      const scopeKey = createDefaultMemoryScopeKey(input.sessionId, input.userId);
      const session = await deps.prisma.agentMemorySession.findUnique({
        where: { scopeKey },
        select: { id: true },
      });
      if (!session) return [];
      const rows = await deps.prisma.agentMemoryMessage.findMany({
        where: { memorySessionId: session.id, role: "user" },
        select: { message: true },
      });
      const wanted = new Set(input.ids);
      const applied: string[] = [];
      for (const row of rows) {
        const message = row.message as Message;
        if (!isRecord(message.metadata)) continue;
        const clientMessageId = message.metadata.clientMessageId;
        if (
          typeof clientMessageId === "string" &&
          wanted.has(clientMessageId)
        ) {
          applied.push(clientMessageId);
        }
      }
      return applied;
    },
  };
}

export type SteerSyncService = ReturnType<typeof createSteerSyncService>;

let service: SteerSyncService | null = null;

export function getSteerSyncService(): SteerSyncService {
  if (!service) {
    service = createSteerSyncService({ prisma: prismaClient });
  }
  return service;
}
