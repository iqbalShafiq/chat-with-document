import type { Job } from "bullmq";
import type { Message } from "@anvia/core/completion";
import { DEFAULT_COMPLETION_PROVIDER } from "@assingment/agent";
import type { Prisma } from "../../generated/prisma/client.js";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { estimateMessagesTokens } from "../../lib/token-estimate.js";
import { prisma } from "../../utils/prisma.js";
import { findActiveModel } from "../models/service.js";
import { tapProfileRefresh } from "../profiling/tap-profile-refresh.js";
import { tapAgentStreamUsage } from "../usage/tap-agent-usage.js";
import { buildChatRunInput } from "./build-run-input.js";
import { compactSessionMemory } from "./compaction.js";
import { compactionConfig, estimateStaticContextTokens } from "./context-usage.js";
import {
  finalizeAssistantCitations,
  tapStreamComplete,
} from "./finalize-assistant-citations.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";
import {
  releaseActiveRun,
  type ChatRunJobData,
} from "./run-queue.js";

export { CHAT_RUN_QUEUE, type ChatRunJobData } from "./run-queue.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STOP_KEY = (streamId: string) => `rs-stop:${streamId}`;

/**
 * Ends the stream early when a stop flag exists (checked between events).
 * A stale flag from a crashed run is cleared when the job starts, so the
 * flag always means "the client asked to stop".
 */
async function* tapStreamStopFlag<T>(
  source: AsyncIterable<T>,
  streamId: string,
): AsyncGenerator<T> {
  for await (const item of source) {
    if (await getRedis().exists(STOP_KEY(streamId))) return;
    yield item;
  }
}

export async function processChatRunJob(job: Job<ChatRunJobData>): Promise<void> {
  const { streamId, sessionId, userId, model, reasoningEffort, promptMessage } = job.data;
  const store = getStreamStore();

  const status = await store.status({ streamId });
  if (status.status !== "running") {
    console.log(`[chat-run] skip ${streamId} (${status.status})`);
    await releaseActiveRun(sessionId, streamId).catch(() => {});
    return;
  }

  // A stale stop flag from a crashed previous run would stop this run before
  // it starts — always clear it at job start.
  await getRedis().del(STOP_KEY(streamId)).catch(() => {});

  try {
    const runInput = await buildChatRunInput({ sessionId, userId, model, reasoningEffort });

    const memoryMessages = await runInput.memory.load({ sessionId, userId });
    const estimated = estimateMessagesTokens(memoryMessages) + estimateStaticContextTokens(runInput);
    const modelInfo = await findActiveModel(model);
    const windowTokens = modelInfo?.contextWindowTokens ?? 1_050_000;

    if (estimated > Math.floor(windowTokens * compactionConfig.triggerRatio)) {
      await store.append({
        streamId,
        event: {
          type: "compaction",
          phase: "start",
          reason: "threshold",
          model,
          estimated,
          threshold: Math.floor(windowTokens * compactionConfig.triggerRatio),
        },
      });
      const result = await compactSessionMemory({
        sessionId,
        userId,
        windowTokens,
        keepTurns: compactionConfig.keepTurns,
        triggerRatio: compactionConfig.triggerRatio,
        targetRatio: compactionConfig.targetRatio,
        summaryBudgetRatio: compactionConfig.summaryBudgetRatio,
      });
      if (!result.skipped) {
        await store.append({
          streamId,
          event: { type: "compaction", phase: "complete", stats: result.stats },
        });
      } else if (result.reason === "summarize-failed") {
        await store.append({
          streamId,
          event: { type: "compaction", phase: "error", reason: result.reason },
        });
      } else {
        // below-threshold: the trigger estimate (memory + static context) can
        // exceed the memory-only check inside compactSessionMemory — nothing
        // went wrong, so surface no compaction event at all.
        console.log(
          `[chat-run] compaction skipped for ${streamId}: ${result.reason}`,
        );
      }
    }

    const stream = runInput.agent
      .session(sessionId, { userId })
      .prompt(promptMessage)
      .withTrace({
        sessionId,
        userId,
        ...(runInput.projectId ? { projectId: runInput.projectId } : {}),
      })
      .stream();

    // Chain (outermost → raw stream): profile refresh → finalize citations →
    // usage audit → stop flag. Profile tap outermost so the background
    // refresh is enqueued last, after the stream fully settles.
    const profiled = tapProfileRefresh(
      tapStreamComplete(
        tapAgentStreamUsage(tapStreamStopFlag(stream, streamId), {
          userId,
          sessionId,
          provider: DEFAULT_COMPLETION_PROVIDER,
          model,
          reasoningEffort,
          agentId: "my-agent",
        }),
        () => finalizeAssistantCitations(sessionId, userId),
      ),
      { userId, projectId: runInput.projectId },
    );

    for await (const event of profiled) {
      await store.append({ streamId, event });
    }

    await store.close({ streamId, status: "completed" });
    await releaseActiveRun(sessionId, streamId).catch(() => {});
    await getRedis().del(STOP_KEY(streamId)).catch(() => {});
  } catch (error) {
    await failChatRun(streamId, error, { sessionId, userId, promptMessage });
    throw error;
  }
}

/**
 * Idempotent failure handling: mark the stream error (only if still running),
 * persist the failed pair (only for runs that were genuinely in-flight),
 * release the active-run lock.
 */
export async function failChatRun(
  streamId: string,
  error: unknown,
  ctx?: { sessionId: string; userId: string; promptMessage: Message },
): Promise<void> {
  const store = getStreamStore();
  const message = error instanceof Error ? error.message : String(error);
  let wasRunning = false;
  try {
    const status = await store.status({ streamId });
    if (status.status === "running") {
      wasRunning = true;
      await store.append({ streamId, event: { type: "error", error: message } });
      await store.close({ streamId, status: "error" });
    }
  } catch (e) {
    console.error("[chat-run] fail close failed", e);
  }
  if (ctx) {
    // Only runs that were genuinely in-flight get the failed pair; a skipped
    // or already-completed stream must not gain a spurious error message.
    if (wasRunning) {
      try {
        await writeFailedPair(ctx.sessionId, ctx.userId, ctx.promptMessage, message);
      } catch (e) {
        console.error("[chat-run] failed pair write failed", e);
      }
    }
    try {
      await releaseActiveRun(ctx.sessionId, streamId);
    } catch {
      /* noop */
    }
  }
}

/**
 * Persist [user prompt, assistant error] as the session tail so the UI shows
 * what failed. Idempotent: skips when the tail is already a kind:"error"
 * assistant row.
 */
export async function writeFailedPair(
  sessionId: string,
  userId: string,
  promptMessage: Message,
  errorText: string,
): Promise<void> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId, userId);
  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (!session) return;

  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: session.id },
    orderBy: { position: "desc" },
    select: { position: true, role: true, message: true },
  });

  const tail = rows[0];
  if (tail) {
    const tailMessage = tail.message as Message;
    if (
      tail.role === "assistant" &&
      isRecord(tailMessage.metadata) &&
      tailMessage.metadata.kind === "error"
    ) {
      return;
    }
  }

  const nextPosition = rows.length === 0 ? 1 : tail!.position + 1;
  const errorMessage: Message = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `Something went wrong while answering. Send again.\n\n${errorText}`,
      },
    ],
    metadata: { kind: "error" },
  } as Message;

  const runId = `failed:${Date.now()}`;
  await prisma.agentMemoryMessage.createMany({
    data: [
      {
        memorySessionId: session.id,
        runId,
        turn: 0,
        position: nextPosition,
        role: "user",
        message: promptMessage as unknown as Prisma.InputJsonValue,
        createdAt: new Date(),
      },
      {
        memorySessionId: session.id,
        runId,
        turn: 0,
        position: nextPosition + 1,
        role: "assistant",
        message: errorMessage as unknown as Prisma.InputJsonValue,
        createdAt: new Date(),
      },
    ],
  });
}
