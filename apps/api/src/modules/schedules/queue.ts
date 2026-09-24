import { Queue } from "bullmq";
import { getBullmqConnectionOptions } from "../../lib/redis.js";

export const SCHEDULE_QUEUE = "workspace-schedule";

export type ScheduleJobData = {
  scheduleId: string;
  userId: string;
  projectId: string | null;
};

let queue: Queue<ScheduleJobData> | null = null;

export function getScheduleQueue(): Queue<ScheduleJobData> {
  if (!queue) {
    queue = new Queue<ScheduleJobData>(SCHEDULE_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}

export function scheduleJobId(scheduleId: string): string {
  return `workspace-schedule:${scheduleId}`;
}

export function nextRunAt(freq: "once" | "daily" | "weekly", from = new Date()): Date {
  if (freq === "daily") return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  if (freq === "weekly") return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return from;
}
