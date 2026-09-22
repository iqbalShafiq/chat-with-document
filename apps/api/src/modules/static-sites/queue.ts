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
  queueOverride?: Pick<Queue<SiteBuildJobData>, "add">,
): Promise<void> {
  if (!siteBuildEnabled()) return;
  const jobId = siteBuildJobId(input.siteId, input.version);
  await (queueOverride ?? getSiteBuildQueue()).add(jobId, input, { jobId });
}
