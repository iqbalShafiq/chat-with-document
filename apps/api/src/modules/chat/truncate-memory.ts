import { isMemoryCompactionMessage } from "@anvia/core/memory";
import { parseMessage, type Message } from "@anvia/core/completion";
import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

export type TruncateMode = "include" | "exclude";

export type TruncateMemoryInput = {
  sessionId: string;
  userId: string;
  mode: TruncateMode;
  /** Prefer when available (history after enrich). */
  memoryPosition?: number;
  /** Prefer for live messages stamped on send. */
  clientMessageId?: string;
  /**
   * Native user+assistant row count strictly before an optimistic prompt.
   * Permits a no-op only when cancellation happened before Anvia persisted
   * that prompt and the authoritative prefix is otherwise unchanged.
   */
  expectedPrefixMessageCount?: number;
};

export type TruncateMemoryResult = {
  ok: true;
  deleted: number;
  keptThrough: number;
  resolvedPosition: number | null;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientMessageIdFromMessage(message: unknown): string | null {
  if (!isJsonObject(message)) return null;
  const metadata = message.metadata;
  if (!isJsonObject(metadata)) return null;
  return typeof metadata.clientMessageId === "string"
    ? metadata.clientMessageId
    : null;
}

function parseStoredMessage(value: unknown): Message {
  // Truncation is a destructive user operation. Keep the same strict v1
  // parser as PrismaMemoryStore and fail closed if a row is malformed.
  return parseMessage(value);
}

const staleTargetMessage =
  "Could not resolve a current target message for truncate; reload the conversation and try again";

/**
 * Truncate agent memory after a target message.
 * - include: keep the target row and everything before it
 * - exclude: keep everything strictly before the target row
 */
export async function truncateSessionMemory(
  input: TruncateMemoryInput,
): Promise<TruncateMemoryResult> {
  const scopeKey = createDefaultMemoryScopeKey(input.sessionId, input.userId);

  return prisma.$transaction(
    async (tx) => {
      const session = await tx.agentMemorySession.findUnique({
        where: { scopeKey },
        select: { id: true },
      });

      if (!session) {
        return {
          ok: true,
          deleted: 0,
          keptThrough: -1,
          resolvedPosition: null,
        };
      }

      const hasPosition =
        typeof input.memoryPosition === "number" &&
        Number.isSafeInteger(input.memoryPosition) &&
        input.memoryPosition >= 0;
      const clientMessageId =
        typeof input.clientMessageId === "string" &&
        input.clientMessageId.trim().length > 0
          ? input.clientMessageId.trim()
          : undefined;
      const expectedPrefixMessageCount =
        typeof input.expectedPrefixMessageCount === "number" &&
        Number.isSafeInteger(input.expectedPrefixMessageCount) &&
        input.expectedPrefixMessageCount >= 0
          ? input.expectedPrefixMessageCount
          : undefined;

      let target: { position: number; message: unknown } | undefined;

      if (hasPosition) {
        // Never trust a stale UI position. Native compaction removes the old
        // prefix and reuses the boundary position for its system summary; an
        // existence check alone would therefore be unsafe.
        target =
          (await tx.agentMemoryMessage.findFirst({
            where: {
              memorySessionId: session.id,
              position: input.memoryPosition,
            },
            select: { position: true, message: true },
          })) ?? undefined;

        if (!target) {
          throw new TruncateTargetNotFoundError(staleTargetMessage);
        }

        const parsed = parseStoredMessage(target.message);
        if (isMemoryCompactionMessage(parsed)) {
          throw new TruncateTargetNotFoundError(staleTargetMessage);
        }
        if (
          clientMessageId !== undefined &&
          clientMessageIdFromMessage(parsed) !== clientMessageId
        ) {
          throw new TruncateTargetNotFoundError(staleTargetMessage);
        }
      } else if (clientMessageId !== undefined) {
        const rows = await tx.agentMemoryMessage.findMany({
          where: {
            memorySessionId: session.id,
            AND: [
              {
                message: {
                  path: ["metadata", "clientMessageId"],
                  equals: clientMessageId,
                },
              },
              { message: { path: ["role"], equals: "user" } },
            ],
          },
          orderBy: { position: "asc" },
          take: 2,
          select: { position: true, message: true },
        });

        if (
          rows.length === 0 &&
          input.mode === "exclude" &&
          expectedPrefixMessageCount !== undefined
        ) {
          const currentPrefixMessageCount =
            await tx.agentMemoryMessage.count({
              where: {
                memorySessionId: session.id,
                role: { in: ["user", "assistant"] },
              },
            });
          if (currentPrefixMessageCount === expectedPrefixMessageCount) {
            return {
              ok: true,
              deleted: 0,
              keptThrough: -1,
              resolvedPosition: null,
            };
          }
        }

        if (rows.length !== 1) {
          throw new TruncateTargetNotFoundError(staleTargetMessage);
        }
        target = rows[0];
        const parsed = parseStoredMessage(target.message);
        if (isMemoryCompactionMessage(parsed)) {
          throw new TruncateTargetNotFoundError(staleTargetMessage);
        }
      }

      if (!target) {
        throw new TruncateTargetNotFoundError(staleTargetMessage);
      }

      const targetPosition = target.position;
      const keepThrough =
        input.mode === "include" ? targetPosition : targetPosition - 1;

      const result = await tx.agentMemoryMessage.deleteMany({
        where: {
          memorySessionId: session.id,
          position: { gt: keepThrough },
        },
      });

      // Touch session updatedAt so history list reorders predictably.
      await tx.agentMemorySession.update({
        where: { id: session.id },
        data: { updatedAt: new Date() },
      });

      return {
        ok: true,
        deleted: result.count,
        keptThrough: keepThrough,
        resolvedPosition: targetPosition,
      };
    },
    // If native compaction wins the race, Prisma aborts this transaction
    // instead of deleting rows after a target that no longer exists.
    { isolationLevel: "Serializable" },
  );
}

export class TruncateTargetNotFoundError extends Error {
  readonly code = "TRUNCATE_TARGET_NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "TruncateTargetNotFoundError";
  }
}
