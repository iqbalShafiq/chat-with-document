import { Worker } from "bullmq";
import { getBullmqConnectionOptions } from "../../lib/redis.js";
import { prisma } from "../../utils/prisma.js";
import { getScheduleQueue, nextRunAt, SCHEDULE_QUEUE, scheduleJobId } from "./queue.js";

export async function runWorkspaceSchedule(input: {
  scheduleId: string;
  userId: string;
}): Promise<{ ok: true; rescheduled: boolean }> {
  const schedule = await prisma.workspaceSchedule.findFirst({
    where: { id: input.scheduleId, userId: input.userId, status: "active" },
  });
  if (!schedule) return { ok: true, rescheduled: false };
  if (schedule.freq === "once") {
    await prisma.workspaceSchedule.update({
      where: { id: schedule.id },
      data: { status: "done" },
    });
    return { ok: true, rescheduled: false };
  }
  const next = nextRunAt(schedule.freq as "daily" | "weekly");
  await prisma.workspaceSchedule.update({
    where: { id: schedule.id },
    data: { nextRunAt: next },
  });
  await getScheduleQueue()
    .add(
      "run",
      { scheduleId: schedule.id, userId: schedule.userId, projectId: schedule.projectId },
      { jobId: `${scheduleJobId(schedule.id)}:${next.getTime()}`, delay: next.getTime() - Date.now() },
    )
    .catch(() => undefined);
  return { ok: true, rescheduled: true };
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

