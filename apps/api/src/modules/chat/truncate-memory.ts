import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

export type TruncateMode = "include" | "exclude";

export type TruncateMemoryInput = {
  sessionId: string;
  mode: TruncateMode;
  /** Prefer when available (history after enrich). */
  memoryPosition?: number;
  /** Prefer for live messages stamped on send. */
  clientMessageId?: string;
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

/**
 * Truncate agent memory after a target message.
 * - include: keep the target row and everything before it
 * - exclude: keep everything strictly before the target row
 */
export async function truncateSessionMemory(
  input: TruncateMemoryInput,
): Promise<TruncateMemoryResult> {
  const scopeKey = createDefaultMemoryScopeKey(input.sessionId);

  const session = await prisma.agentMemorySession.findUnique({
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

  let targetPosition: number | null = null;

  if (
    typeof input.memoryPosition === "number" &&
    Number.isInteger(input.memoryPosition) &&
    input.memoryPosition >= 0
  ) {
    targetPosition = input.memoryPosition;
  } else if (
    typeof input.clientMessageId === "string" &&
    input.clientMessageId.trim().length > 0
  ) {
    const rows = await prisma.agentMemoryMessage.findMany({
      where: { memorySessionId: session.id },
      orderBy: { position: "asc" },
      select: { position: true, message: true },
    });

    const match = rows.find(
      (row) => clientMessageIdFromMessage(row.message) === input.clientMessageId,
    );
    targetPosition = match?.position ?? null;
  }

  if (targetPosition === null) {
    throw new TruncateTargetNotFoundError(
      "Could not resolve target message for truncate",
    );
  }

  const keepThrough =
    input.mode === "include" ? targetPosition : targetPosition - 1;

  const result = await prisma.agentMemoryMessage.deleteMany({
    where: {
      memorySessionId: session.id,
      position: { gt: keepThrough },
    },
  });

  // Touch session updatedAt so history list reorders predictably.
  await prisma.agentMemorySession.update({
    where: { id: session.id },
    data: { updatedAt: new Date() },
  });

  return {
    ok: true,
    deleted: result.count,
    keptThrough: keepThrough,
    resolvedPosition: targetPosition,
  };
}

export class TruncateTargetNotFoundError extends Error {
  readonly code = "TRUNCATE_TARGET_NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "TruncateTargetNotFoundError";
  }
}
