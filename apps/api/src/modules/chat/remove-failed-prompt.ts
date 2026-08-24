import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

export class FailedPromptCleanupError extends Error {
  readonly code = "FAILED_PROMPT_CLEANUP_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "FailedPromptCleanupError";
  }
}

/**
 * Delete exactly the user prompt persisted by a failed, pre-visible attempt.
 * Missing or duplicate identities fail closed so retry can never truncate or
 * silently corrupt adjacent memory.
 */
export async function removeFailedPromptForRetry(input: {
  sessionId: string;
  userId: string;
  clientMessageId: string;
}): Promise<void> {
  const scopeKey = createDefaultMemoryScopeKey(input.sessionId, input.userId);

  await prisma.$transaction(async (tx) => {
    const session = await tx.agentMemorySession.findUnique({
      where: { scopeKey },
      select: { id: true },
    });
    if (!session) throw new FailedPromptCleanupError("memory session not found");

    const rows = await tx.agentMemoryMessage.findMany({
      where: {
        memorySessionId: session.id,
        AND: [
          {
            message: {
              path: ["metadata", "clientMessageId"],
              equals: input.clientMessageId,
            },
          },
          { message: { path: ["role"], equals: "user" } },
        ],
      },
      orderBy: { position: "asc" },
      take: 2,
      select: { id: true },
    });

    if (rows.length !== 1) {
      throw new FailedPromptCleanupError(
        rows.length === 0 ? "failed prompt not found" : "failed prompt identity is ambiguous",
      );
    }

    const deleted = await tx.agentMemoryMessage.deleteMany({
      where: { id: rows[0]!.id, memorySessionId: session.id },
    });
    if (deleted.count !== 1) {
      throw new FailedPromptCleanupError("failed prompt changed during cleanup");
    }
  });
}
