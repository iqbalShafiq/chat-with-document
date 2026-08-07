import { Queue } from "bullmq";
import type { Message } from "@anvia/core/completion";
import { getBullmqConnectionOptions, getRedis } from "../../lib/redis.js";

export const CHAT_RUN_QUEUE = "chat-run";

export type ChatRunJobData = {
  streamId: string;
  sessionId: string;
  userId: string;
  model: string;
  reasoningEffort: string | null;
  /** Per-session web-search toggle state (default false). */
  webSearchEnabled: boolean;
  promptMessage: Message;
  createdAt: string;
};

let queue: Queue<ChatRunJobData> | null = null;

export function getChatRunQueue(): Queue<ChatRunJobData> {
  if (!queue) {
    queue = new Queue<ChatRunJobData>(CHAT_RUN_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}

export async function enqueueChatRun(
  jobId: string,
  data: ChatRunJobData,
): Promise<void> {
  await getChatRunQueue().add(jobId, data);
}

export const ACTIVE_RUN_KEY = (sessionId: string) => `rs-active:${sessionId}`;

const ACTIVE_RUN_TTL_SECONDS = 600;

/** SET NX: claim the session's single active run. False when one is running. */
export async function tryAcquireActiveRun(
  sessionId: string,
  streamId: string,
  ttlSeconds?: number,
): Promise<boolean> {
  const result = await getRedis().set(
    ACTIVE_RUN_KEY(sessionId),
    streamId,
    "EX",
    ttlSeconds ?? ACTIVE_RUN_TTL_SECONDS,
    "NX",
  );
  return result === "OK";
}

/** Compare-and-delete: only release the lock we actually own. */
export async function releaseActiveRun(
  sessionId: string,
  streamId: string,
): Promise<void> {
  const redis = getRedis();
  const current = await redis.get(ACTIVE_RUN_KEY(sessionId));
  if (current === streamId) {
    await redis.del(ACTIVE_RUN_KEY(sessionId));
  }
}
