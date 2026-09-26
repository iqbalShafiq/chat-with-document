import { Worker } from "bullmq";
import { getBullmqConnectionOptions } from "../../lib/redis.js";
import { prisma } from "../../utils/prisma.js";
import {
  getScheduleQueue,
  nextRunAt,
  SCHEDULE_QUEUE,
  scheduleFollowUpJobId,
  scheduleRetryJobId,
} from "./queue.js";
import { startScheduledChatRun, type ScheduledRunResult } from "./start-run.js";

const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export type ScheduleExecutionDeps = {
  loadSchedule: (scheduleId: string, userId: string) => Promise<{
    id: string;
    userId: string;
    projectId: string | null;
    sessionId: string | null;
    prompt: string;
    freq: string;
    status: string;
    attempts: number;
  } | null>;
  updateSchedule: (id: string, data: Record<string, unknown>) => Promise<void>;
  startRun: (input: { userId: string; sessionId: string; prompt: string }) => Promise<ScheduledRunResult>;
  enqueue: (
    jobId: string,
    data: { scheduleId: string; userId: string; projectId: string | null },
    delayMs: number,
  ) => Promise<void>;
  now?: () => Date;
};

/**
 * Execute a due schedule: run the stored prompt in its frozen session via
 * the normal chat-run pipeline, then reschedule or dead-letter. A busy
 * session retries later without counting an attempt; three real failures
 * mark the schedule `failed` (spec §4.5).
 */
export async function runWorkspaceSchedule(
  input: { scheduleId: string; userId: string },
  deps: ScheduleExecutionDeps = productionDeps(),
): Promise<{ ok: true; rescheduled: boolean }> {
  const schedule = await deps.loadSchedule(input.scheduleId, input.userId);
  if (!schedule || schedule.status !== "active") {
    return { ok: true, rescheduled: false };
  }
  const now = deps.now?.() ?? new Date();
  const jobData = {
    scheduleId: schedule.id,
    userId: schedule.userId,
    projectId: schedule.projectId,
  };

  const fail = async (message: string): Promise<{ ok: true; rescheduled: boolean }> => {
    const attempts = schedule.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await deps.updateSchedule(schedule.id, {
        attempts,
        status: "failed",
        lastError: message,
        lastRunAt: now,
      });
      return { ok: true, rescheduled: false };
    }
    const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
    await deps.updateSchedule(schedule.id, {
      attempts,
      lastError: message,
      nextRunAt: retryAt,
    });
    await deps.enqueue(
      scheduleRetryJobId(schedule.id, retryAt.getTime()),
      jobData,
      RETRY_DELAY_MS,
    );
    return { ok: true, rescheduled: true };
  };

  if (!schedule.sessionId) {
    return fail("Schedule has no session");
  }

  const result = await deps.startRun({
    userId: schedule.userId,
    sessionId: schedule.sessionId,
    prompt: schedule.prompt,
  });

  if (result.status === "busy") {
    // Another run owns the session; try again shortly, not a failure.
    const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
    await deps.updateSchedule(schedule.id, { nextRunAt: retryAt });
    await deps.enqueue(
      scheduleRetryJobId(schedule.id, retryAt.getTime()),
      jobData,
      RETRY_DELAY_MS,
    );
    return { ok: true, rescheduled: true };
  }
  if (result.status === "session-missing") return fail("Session not found");
  if (result.status === "failed") return fail(result.message);

  await deps.updateSchedule(schedule.id, {
    lastRunAt: now,
    lastError: null,
    attempts: 0,
    ...(schedule.freq === "once" ? { status: "done" } : {}),
  });
  if (schedule.freq === "once") return { ok: true, rescheduled: false };

  const next = nextRunAt(schedule.freq as "daily" | "weekly", now);
  await deps.updateSchedule(schedule.id, { nextRunAt: next });
  await deps.enqueue(
    scheduleFollowUpJobId(schedule.id, next.getTime()),
    jobData,
    Math.max(0, next.getTime() - now.getTime()),
  );
  return { ok: true, rescheduled: true };
}

function productionDeps(): ScheduleExecutionDeps {
  return {
    loadSchedule: (scheduleId, userId) =>
      prisma.workspaceSchedule.findFirst({
        where: { id: scheduleId, userId },
        select: {
          id: true,
          userId: true,
          projectId: true,
          sessionId: true,
          prompt: true,
          freq: true,
          status: true,
          attempts: true,
        },
      }),
    updateSchedule: async (id, data) => {
      await prisma.workspaceSchedule.update({ where: { id }, data: data as never });
    },
    startRun: (args) => startScheduledChatRun(args),
    enqueue: async (jobId, data, delayMs) => {
      await getScheduleQueue().add("run", data, { jobId, delay: Math.max(0, delayMs) });
    },
  };
}

export function createScheduleWorker(): Worker {
  return new Worker(
    SCHEDULE_QUEUE,
    async (job) => {
      const data = job.data as { scheduleId: string; userId: string };
      await runWorkspaceSchedule({ scheduleId: data.scheduleId, userId: data.userId });
    },
    { connection: getBullmqConnectionOptions() },
  );
}
