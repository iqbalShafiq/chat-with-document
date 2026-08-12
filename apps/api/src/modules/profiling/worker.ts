import { Worker } from "bullmq";
import type { ProfileScope } from "@assingment/agent";
import { getBullmqConnectionOptions } from "../../lib/redis.js";
import {
  PROFILE_QUEUE,
  getPendingReconsiderations,
  profileJobId,
  removePendingReconsiderations,
  setNeedsProfileRefresh,
  takeNeedsProfileRefresh,
  type ProfileRefreshJobData,
} from "./queue.js";
import {
  loadProfileDelta,
  profileConfig,
  summarizeProfileForScope,
} from "./service.js";

export function scopeFromJobData(data: ProfileRefreshJobData): ProfileScope {
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

  const reconsiderations = await getPendingReconsiderations(scope);
  const result = await summarizeProfileForScope(
    scope,
    reconsiderations.length > 0 ? { reconsiderations } : undefined,
  );
  const processed = result.processed;

  // Consume pending reconsiderations only after a successful pass, so a
  // failed job retry still re-runs the reconsideration. Only the entries we
  // read are removed — anything enqueued during the pass survives for the
  // next pass (the needs-refresh follow-up re-reads the list).
  await removePendingReconsiderations(scope, reconsiderations);

  // Always close the loop: a chat that finished while this job was running
  // (or a needs-refresh flag set by enqueue) must guarantee a follow-up run.
  // Set the flag only here — it is consumed by the worker's completed/failed
  // event handlers, which schedule the real successor job once this job is no
  // longer active (enqueueing from inside the processor would hit the active
  // branch and never create a successor).
  let needsFollowUp = await takeNeedsProfileRefresh(scope);
  if (!needsFollowUp && processed > 0 && result.watermark) {
    const leftover = await loadProfileDelta(scope, result.watermark);
    needsFollowUp = leftover.length > 0;
  }
  if (needsFollowUp) {
    await setNeedsProfileRefresh(scope);
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
