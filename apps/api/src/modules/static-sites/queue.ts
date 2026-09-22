import { Queue } from "bullmq";
import type { SiteBrief } from "@anreal/agent";
import { getBullmqConnectionOptions } from "../../lib/redis.js";
import { siteBuildEnabled } from "./service.js";

export const SITE_BUILD_QUEUE = "site-build";

export type SiteBuildJobData = {
  siteId: string;
  sessionId: string;
  userId: string;
  prompt: string;
  brief: SiteBrief | null;
  version: number;
};

let queue: Queue<SiteBuildJobData> | null = null;

export function getSiteBuildQueue(): Queue<SiteBuildJobData> {
  if (!queue) {
    queue = new Queue<SiteBuildJobData>(SITE_BUILD_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export function siteBuildJobId(siteId: string, version: number): string {
  return `site-build:${siteId}:v${version}`;
}

export async function enqueueSiteBuild(
  input: SiteBuildJobData,
  queueOverride?: Pick<Queue<SiteBuildJobData>, "add" | "getJob">,
): Promise<void> {
  if (!siteBuildEnabled()) return;
  const jobId = siteBuildJobId(input.siteId, input.version);
  const queue = queueOverride ?? getSiteBuildQueue();
  // Re-adding a failed version would dedupe onto the dead record and never
  // run. Re-run that record instead so retry truly rebuilds.
  const existing = await queue.getJob(jobId).catch(() => null);
  if (existing) {
    const state = await existing.getState().catch(() => null);
    if (state === "failed" && typeof existing.retry === "function") {
      await existing.retry();
      return;
    }
  }
  await queue.add(jobId, input, { jobId });
}
