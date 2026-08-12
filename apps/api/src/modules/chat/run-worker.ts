import type { Job } from "bullmq";
import { Message, UserContent, type Message as MessageType } from "@anvia/core/completion";
import { DEFAULT_COMPLETION_PROVIDER } from "@assingment/agent";
import type { Prisma } from "../../generated/prisma/client.js";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { estimateMessagesTokens } from "../../lib/token-estimate.js";
import { prisma } from "../../utils/prisma.js";
import { findActiveModel } from "../models/service.js";
import { tapProfileRefresh } from "../profiling/tap-profile-refresh.js";
import { tapAgentStreamUsage } from "../usage/tap-agent-usage.js";
import { getContext7McpServer } from "../../lib/context7-server.js";
import { getApprovalRegistry } from "./approval-registry.js";
import { getImageStore } from "../images/service.js";
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

/**
 * OpenRouter intermittently returns "The requested model '...' does not exist"
 * for catalogued models (routing to a degraded provider / snapshot sync). The
 * model exists — the very same request succeeds seconds later. When the FIRST
 * event of a run is this transient error, drop the attempt (nothing was
 * generated or appended to the stream yet) and retry the run once. Any other
 * error — or a second occurrence — flows through the normal failure path.
 */
function isTransientModelNotFoundError(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "error") return false;
  const raw = event.error;
  const message =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? raw.message
        : isRecord(raw) && typeof raw.message === "string"
          ? raw.message
          : "";
  return /does not exist/i.test(message);
}

async function* withTransientModelRetry<T>(
  sourceFactory: () => AsyncIterable<T>,
  onRetry: () => Promise<void>,
): AsyncGenerator<T> {
  let retried = false;
  for (;;) {
    let hitTransient = false;
    let first = true;
    for await (const item of sourceFactory()) {
      if (first && !retried && isTransientModelNotFoundError(item)) {
        hitTransient = true;
        break;
      }
      first = false;
      yield item;
    }
    if (!hitTransient) return;
    retried = true;
    console.log("[chat-run] transient 'model does not exist', retrying run once");
    await onRetry();
  }
}

/**
 * The agent's memory store (savePolicy "message") appends the prompt at run
 * start; a retried run would append it again. Delete the failed attempt's
 * prompt row (matched by clientMessageId, falling back to content equality).
 */
async function removeAppendedPromptRow(
  sessionId: string,
  userId: string,
  promptMessage: Message,
): Promise<void> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId, userId);
  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (!session) return;
  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: session.id },
    select: { id: true, role: true, message: true },
  });
  const promptMetadata = isRecord(promptMessage.metadata)
    ? promptMessage.metadata
    : undefined;
  const promptClientId =
    typeof promptMetadata?.clientMessageId === "string"
      ? promptMetadata.clientMessageId
      : null;
  const targets = rows.filter((row) => {
    if (row.role !== "user") return false;
    const message = row.message as Message;
    if (promptClientId !== null) {
      return (
        isRecord(message.metadata) &&
        message.metadata.clientMessageId === promptClientId
      );
    }
    return JSON.stringify(message) === JSON.stringify(promptMessage);
  });
  if (targets.length > 0) {
    await prisma.agentMemoryMessage.deleteMany({
      where: { id: { in: targets.map((row) => row.id) } },
    });
  }
}

export async function processChatRunJob(job: Job<ChatRunJobData>): Promise<void> {
  const {
    streamId,
    sessionId,
    userId,
    model,
    reasoningEffort,
    webSearchEnabled,
    imageGenerationEnabled,
    imageGenSettings,
    promptMessage,
  } = job.data;
  const store = getStreamStore();

  const status = await store.status({ streamId });
  if (status.status !== "running") {
    console.log(`[chat-run] skip ${streamId} (${status.status})`);
    await releaseActiveRun(sessionId, streamId).catch(() => {});
    return;
  }

  // The session may have been deleted while this job waited. The memory store
  // upserts its session row, so running would resurrect the deleted session.
  const chatSessionExists = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!chatSessionExists) {
    console.log(`[chat-run] skip ${streamId} (session deleted)`);
    await releaseActiveRun(sessionId, streamId).catch(() => {});
    return;
  }

  // A stale stop flag from a crashed previous run would stop this run before
  // it starts — always clear it at job start.
  await getRedis().del(STOP_KEY(streamId)).catch(() => {});

  try {
    // Approval handler routes web-tool confirmations through the stream so
    // the UI can ask the user; decisions arrive via the API route.
    const approvalHandler = getApprovalRegistry().createHandler({
      userId,
      sessionId,
      streamId,
      append: (event) =>
        store.append({ streamId, event }).then(() => undefined),
    });

    // Grant/override lookups are live per-call reads (grants can be issued
    // mid-run via the decision route), so they wrap the registry directly.
    const grantHelpers = {
      hasGrant: (toolName: string) =>
        getApprovalRegistry().hasToolGrant(sessionId, toolName),
      takeToolOverride: (toolName: string) =>
        getApprovalRegistry().takeToolOverride(sessionId, toolName),
    };

    // Clarification requests suspend the run until the user answers via the
    // API route, surfacing each request as a stream event.
    const clarificationRequester = getApprovalRegistry().createClarificationRequester(
      {
        userId,
        sessionId,
        streamId,
        append: (event) =>
          store.append({ streamId, event }).then(() => undefined),
      },
    );

    const runInput = await buildChatRunInput({
      sessionId,
      userId,
      model,
      reasoningEffort,
      promptMessage,
      webSearchEnabled,
      imageGenerationEnabled,
      imageGenSettings,
      grantHelpers,
      clarificationRequester,
      approvals: { handler: approvalHandler },
      context7Server: await getContext7McpServer(),
    });

    // Active image context is single-use: it is consumed by this run, so
    // clear it after loading (the r2 keys stay in runInput for this run and
    // any transient retry). Best-effort — a leftover row is pruned the next
    // time a run consumes context.
    if (runInput.activeContextImages.length > 0) {
      await getImageStore()
        .clearSessionImageContexts({ userId, sessionId })
        .catch(() => {
          // non-fatal: next run re-clears
        });
    }

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

    // Active image context: prepend pinned images as image input to the user
    // prompt (only when the selected model accepts image input). The context
    // block from build-run-input describes them for non-image models.
    const modelAcceptsImage =
      modelInfo?.inputModalities?.includes("image") ?? false;
    let effectivePrompt = promptMessage;
    if (runInput.activeContextImages.length > 0 && modelAcceptsImage) {
      const imageContents = [];
      for (const image of runInput.activeContextImages) {
        try {
          const data = await getImageStore().getObjectBuffer(image.r2Key);
          imageContents.push(
            UserContent.imageBase64(
              Buffer.from(data).toString("base64"),
              image.mediaType,
              { detail: "auto" },
            ),
          );
        } catch (error) {
          console.error("[chat-run] active context image fetch failed", {
            imageId: image.id,
            error,
          });
        }
      }
      if (imageContents.length > 0) {
        const content = promptMessage.content;
        const textParts = Array.isArray(content)
          ? content.filter(
              (item): item is Extract<typeof item, { type: "text" }> =>
                item.type === "text",
            )
          : [UserContent.text(content)];
        effectivePrompt = Message.user(
          [...imageContents, ...textParts],
          { metadata: promptMessage.metadata },
        );
      }
    }

    // The transient-retry wrapper sits between the raw agent stream and the
    // audit taps, so a dropped attempt records nothing (no usage, no stream
    // events, no citations) — only the retried stream flows into the taps.
    const rawFactory = () =>
      runInput.agent
        .session(sessionId, { userId })
        .prompt(effectivePrompt)
        .withTrace({
          sessionId,
          userId,
          ...(runInput.projectId ? { projectId: runInput.projectId } : {}),
        })
        .stream();

    const stream = withTransientModelRetry(
      rawFactory,
      () => removeAppendedPromptRow(sessionId, userId, promptMessage),
    );

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

  // The agent's memory store (savePolicy "message") already appended the
  // prompt at run start, so only write it when the tail isn't that prompt
  // (matched by clientMessageId, falling back to exact content equality).
  const promptMetadata = isRecord(promptMessage.metadata)
    ? promptMessage.metadata
    : undefined;
  const promptClientId =
    typeof promptMetadata?.clientMessageId === "string"
      ? promptMetadata.clientMessageId
      : null;
  const tailIsPrompt =
    tail?.role === "user" &&
    (promptClientId !== null
      ? (() => {
          const meta = (tail.message as Message).metadata;
          return (
            isRecord(meta) && meta.clientMessageId === promptClientId
          );
        })()
      : JSON.stringify(tail.message) === JSON.stringify(promptMessage));

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
      ...(tailIsPrompt
        ? []
        : [
            {
              memorySessionId: session.id,
              runId,
              turn: 0,
              position: nextPosition,
              role: "user",
              message: promptMessage as unknown as Prisma.InputJsonValue,
              createdAt: new Date(),
            },
          ]),
      {
        memorySessionId: session.id,
        runId,
        turn: 0,
        position: nextPosition + (tailIsPrompt ? 0 : 1),
        role: "assistant",
        message: errorMessage as unknown as Prisma.InputJsonValue,
        createdAt: new Date(),
      },
    ],
  });
}
