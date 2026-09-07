import { parseMessage, type Message } from "@anvia/core/completion";
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

function isClientMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
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
      if (
        input.ids.length === 0 ||
        input.ids.length > MAX_SYNC_IDS ||
        input.ids.some((id) => !isClientMessageId(id))
      ) {
        throw new Error("steering sync ids are invalid");
      }
      const requested = [...new Set(input.ids)];
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
      const wanted = new Set(requested);
      const applied = new Set<string>();
      for (const row of rows) {
        let message: Message;
        try {
          // The sync path is read-only and must ignore stale/v0 rows rather
          // than coercing them into a v1 message or deleting queue state.
          message = parseMessage(row.message);
        } catch {
          continue;
        }
        if (message.role !== "user") continue;
        if (!isRecord(message.metadata)) continue;
        const clientMessageId = message.metadata.clientMessageId;
        if (
          isClientMessageId(clientMessageId) &&
          wanted.has(clientMessageId)
        ) {
          applied.add(clientMessageId);
        }
      }
      return requested.filter((id) => applied.has(id));
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
