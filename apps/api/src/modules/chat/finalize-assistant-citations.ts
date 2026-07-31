import {
  citationsToJsonValue,
  extractTextFromMessageJson,
  parseCitationsFromText,
  publishCitationGroundedness,
  tracing,
} from "@assingment/agent";
import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * After a chat stream completes:
 * 1. Read the latest assistant memory row
 * 2. Parse [[cite:N]] + ```citations trailer
 * 3. Dual-write structured citations onto message.metadata
 * 4. Publish citation_groundedness to Langfuse when signals exist
 */
export async function finalizeAssistantCitations(sessionId: string): Promise<void> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId);

  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (!session) return;

  const row = await prisma.agentMemoryMessage.findFirst({
    where: {
      memorySessionId: session.id,
      role: "assistant",
    },
    orderBy: { position: "desc" },
    select: {
      id: true,
      message: true,
    },
  });
  if (!row) return;

  const message = row.message;
  if (!isJsonObject(message)) return;

  const rawText = extractTextFromMessageJson(message);
  if (!rawText.trim()) return;

  const { citations } = parseCitationsFromText(rawText);

  // Dual-write structured citations (even empty clears stale if re-run).
  const existingMeta = isJsonObject(message.metadata) ? message.metadata : {};
  const nextMessage = {
    ...message,
    metadata: {
      ...existingMeta,
      citations: citationsToJsonValue(citations),
    },
  };

  await prisma.agentMemoryMessage.update({
    where: { id: row.id },
    data: { message: nextMessage },
  });

  await publishCitationGroundedness({
    tracing,
    rawAssistantText: rawText,
    sessionId,
  });
}

/** AsyncIterable tap that runs work after a successful full consume. */
export async function* tapStreamComplete<T>(
  source: AsyncIterable<T>,
  onComplete: () => void | Promise<void>,
): AsyncGenerator<T> {
  let succeeded = false;
  try {
    for await (const item of source) {
      yield item;
    }
    succeeded = true;
  } finally {
    if (succeeded) {
      try {
        await onComplete();
      } catch (error) {
        console.error("[citations] finalize after stream failed", error);
      }
    }
  }
}
