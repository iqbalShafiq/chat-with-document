import { Queue } from "bullmq";
import { getBullmqConnectionOptions } from "../../lib/redis.js";

export const SESSION_TITLE_QUEUE = "session-title";

export type SessionTitleJobData = {
  sessionId: string;
  userId: string;
  seed: string;
  prompt: string;
};

let queue: Queue<SessionTitleJobData> | null = null;

export function getSessionTitleQueue(): Queue<SessionTitleJobData> {
  if (!queue) {
    queue = new Queue<SessionTitleJobData>(SESSION_TITLE_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}

export function sessionTitleJobId(sessionId: string): string {
  return `session-title:${sessionId}`;
}

export async function enqueueSessionTitle(
  input: SessionTitleJobData,
  queueOverride?: Pick<Queue<SessionTitleJobData>, "add">,
): Promise<void> {
  await (queueOverride ?? getSessionTitleQueue()).add(
    sessionTitleJobId(input.sessionId),
    input,
  );
}
