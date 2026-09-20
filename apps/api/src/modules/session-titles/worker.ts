import { Worker } from "bullmq";
import { generateSessionTitle } from "@anreal/agent";
import { getBullmqConnectionOptions } from "../../lib/redis.js";
import { normalizeSessionTitle } from "../chat/chat-session.js";
import { SESSION_TITLE_QUEUE, type SessionTitleJobData } from "./queue.js";
import {
  SESSION_TITLE_TIMEOUT_MS,
  applyGeneratedSessionTitle,
  publishSessionTitleEvent,
  sessionTitleConfig,
} from "./service.js";

export async function processSessionTitleJob(job: {
  data: SessionTitleJobData;
}): Promise<void> {
  const config = sessionTitleConfig();
  const startedAt = Date.now();

  const { title: rawTitle, usage } = await generateSessionTitle({
    model: config.model,
    prompt: job.data.prompt,
    abortSignal: AbortSignal.timeout(SESSION_TITLE_TIMEOUT_MS),
  });

  const title = normalizeSessionTitle(rawTitle);
  if (!title || title === job.data.seed) {
    console.log(`[title] noop ${job.data.sessionId}`);
    return;
  }

  const applied = await applyGeneratedSessionTitle({
    sessionId: job.data.sessionId,
    userId: job.data.userId,
    seed: job.data.seed,
    title,
  });
  if (!applied) {
    console.log(`[title] skipped ${job.data.sessionId} (title changed)`);
    return;
  }

  await publishSessionTitleEvent({
    sessionId: job.data.sessionId,
    title,
  }).catch((error) => {
    console.warn(`[title] event publish failed ${job.data.sessionId}`, error);
  });

  console.log(
    `[title] applied ${job.data.sessionId} (${Date.now() - startedAt}ms, ${usage.inputTokens} in / ${usage.outputTokens} out)`,
  );
}

export function createSessionTitleWorker(): Worker<SessionTitleJobData> {
  return new Worker<SessionTitleJobData>(
    SESSION_TITLE_QUEUE,
    async (job) => {
      try {
        await processSessionTitleJob(job);
      } catch (error) {
        console.error(`[title] failed ${job.id}`, error);
        throw error;
      }
    },
    {
      connection: getBullmqConnectionOptions(),
      concurrency: sessionTitleConfig().concurrency,
    },
  );
}
