import { createCompletionModel, parseCompletionModel } from "@anreal/agent";
import type { CompletionModel } from "@anvia/core";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { prisma } from "../../utils/prisma.js";
import { ACTIVE_RUN_KEY } from "../chat/run-queue.js";
import { mapChatAppEvent, toChatResumableEvent } from "../chat/client-events.js";

export const DEFAULT_TITLE_MODEL = "openai/gpt-5-nano";
export const SESSION_TITLE_TIMEOUT_MS = 15_000;

export type SessionTitleConfig = {
  enabled: boolean;
  concurrency: number;
  model: CompletionModel;
};

export function sessionTitleConfig(): SessionTitleConfig {
  const enabled = process.env.TITLE_ENABLED !== "false";
  const concurrency = Number(process.env.TITLE_WORKER_CONCURRENCY ?? "3");
  const modelId = parseCompletionModel(process.env.TITLE_MODEL);
  return {
    enabled,
    concurrency:
      Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 3,
    model: createCompletionModel(modelId ?? DEFAULT_TITLE_MODEL),
  };
}

export async function applyGeneratedSessionTitle(input: {
  sessionId: string;
  userId: string;
  seed: string;
  title: string;
}): Promise<boolean> {
  const updated = await prisma.chatSession.updateMany({
    where: {
      id: input.sessionId,
      userId: input.userId,
      OR: [{ title: null }, { title: "" }, { title: input.seed }],
    },
    data: { title: input.title },
  });
  return updated.count > 0;
}

export async function publishSessionTitleEvent(input: {
  sessionId: string;
  title: string;
}): Promise<void> {
  const streamId = await getRedis().get(ACTIVE_RUN_KEY(input.sessionId));
  if (!streamId) return;

  const event = mapChatAppEvent(
    { type: "session_title_updated", sessionId: input.sessionId, title: input.title },
    { runId: streamId },
  );
  if (!event) return;

  await getStreamStore().append({ streamId, event: toChatResumableEvent(event) });
}
