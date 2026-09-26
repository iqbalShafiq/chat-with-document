import { randomUUID } from "node:crypto";
import type { Message } from "@anvia/core/completion";
import { DEFAULT_COMPLETION_MODEL } from "@anreal/agent";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { getChatSession, touchChatSession } from "../chat/chat-session.js";
import { resolveChatAgentRecipe } from "../chat/build-run-input.js";
import {
  ChatRunReconciliationError,
  enqueueChatRun,
  releaseActiveRun,
  tryAcquireActiveRun,
} from "../chat/run-queue.js";

export type ScheduledRunResult =
  | { status: "started"; streamId: string }
  | { status: "busy" }
  | { status: "session-missing" }
  | { status: "failed"; message: string };

/**
 * Start a chat run for a due schedule: the stored prompt becomes a user turn
 * in the schedule's origin session, executed by the normal chat-run worker
 * (same recipe/lock/stream protocol as POST /api/chat). The follow-up reply
 * lands in that session — that is the notification.
 */
export async function startScheduledChatRun(input: {
  userId: string;
  sessionId: string;
  prompt: string;
}): Promise<ScheduledRunResult> {
  const streamId = randomUUID();
  const store = getStreamStore();
  let recipe;
  let promptMessage: Message;
  try {
    // Deleted session ends the schedule — never auto-create a new one.
    try {
      await getChatSession(input.userId, input.sessionId);
    } catch {
      return { status: "session-missing" };
    }
    promptMessage = {
      role: "user",
      content: [{ type: "text", text: `[Scheduled task]\n${input.prompt}` }],
      metadata: {
        createdAt: new Date().toISOString(),
        clientMessageId: randomUUID(),
        documentIds: [],
        attachedDocuments: [],
      },
    } as Message;
    recipe = await resolveChatAgentRecipe({
      sessionId: input.sessionId,
      userId: input.userId,
      model: DEFAULT_COMPLETION_MODEL,
      reasoningEffort: null,
      promptMessage,
      webSearchEnabled: false,
      imageGenerationEnabled: false,
      deepResearchEnabled: false,
      traceId: streamId,
      streamId,
      consumeSingleUseContext: false,
    });
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message.slice(0, 300) : "recipe resolution failed",
    };
  }

  const acquired = await tryAcquireActiveRun(input.sessionId, streamId, 2 * 60 * 60);
  if (!acquired) return { status: "busy" };

  let opened = false;
  try {
    await store.openWithMeta(
      { streamId },
      {
        userId: input.userId,
        sessionId: input.sessionId,
        modelId: DEFAULT_COMPLETION_MODEL,
        reasoningEffort: null,
      },
    );
    opened = true;
    await enqueueChatRun(`chat:${streamId}`, {
      kind: "start",
      streamId,
      sessionId: input.sessionId,
      userId: input.userId,
      recipe,
      prompt: promptMessage,
      createdAt: new Date().toISOString(),
    });
    await touchChatSession(input.userId, input.sessionId).catch((error) => {
      console.warn("[schedules] session touch failed", { sessionId: input.sessionId, error });
    });
    return { status: "started", streamId };
  } catch (error) {
    if (error instanceof ChatRunReconciliationError) {
      // The job was accepted; keep the stream + lease alive like the router.
      return { status: "started", streamId };
    }
    if (opened) {
      await store.close({ streamId, status: "error" }).catch(() => undefined);
    }
    await releaseActiveRun(input.sessionId, streamId).catch(() => undefined);
    return {
      status: "failed",
      message: error instanceof Error ? error.message.slice(0, 300) : "enqueue failed",
    };
  }
}
