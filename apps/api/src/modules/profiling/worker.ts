import { Worker } from "bullmq";
import type { ProfileScope } from "@assingment/agent";
import { getBullmqConnectionOptions } from "../../lib/redis.js";
import {
  PROFILE_QUEUE,
  enqueueProfileRefresh,
  profileJobId,
  takeNeedsProfileRefresh,
  type ProfileRefreshJobData,
} from "./queue.js";
import {
  loadProfileDelta,
  profileConfig,
  summarizeProfileForScope,
} from "./service.js";

function scopeFromJobData(data: ProfileRefreshJobData): ProfileScope {
  return data.kind === "project" && data.projectId
    ? { kind: "project", userId: data.userId, projectId: data.projectId }
    : { kind: "user", userId: data.userId };
}

async function processProfileJob(job: {
  id?: string;
  data: ProfileRefreshJobData;
}): Promise<void> {
  const scope = scopeFromJobData(job.data);
  console.log(`[profile] summarize start ${profileJobId(scope)}`);

  const result = await summarizeProfileForScope(scope);
  const processed = result.processed;

  // Always close the loop: a chat that finished while this job was running
  // (or a needs-refresh flag set by enqueue) must guarantee a follow-up run.
  let needsFollowUp = await takeNeedsProfileRefresh(scope);
  if (!needsFollowUp && processed > 0 && result.watermark) {
    const leftover = await loadProfileDelta(scope, result.watermark);
    needsFollowUp = leftover.length > 0;
  }
  if (needsFollowUp) {
    await enqueueProfileRefresh(scope);
  }

  console.log(`[profile] summarize done ${profileJobId(scope)} (${processed})`);
}

export function createProfileWorker(): Worker<ProfileRefreshJobData> {
  return new Worker<ProfileRefreshJobData>(
    PROFILE_QUEUE,
    async (job) => {
      try {
        await processProfileJob(job);
      } catch (error) {
        // Throwing lets BullMQ apply attempts/backoff; on exhaustion the job
        // dies and recovery happens on the next chat enqueue (by design).
        console.error(`[profile] summarize failed ${job.id}`, error);
        throw error;
      }
    },
    {
      connection: getBullmqConnectionOptions(),
      concurrency: profileConfig().concurrency,
    },
  );
}
