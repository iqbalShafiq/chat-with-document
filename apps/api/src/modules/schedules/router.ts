import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import { artifactWhere } from "../artifacts/scope.js";
import { resolveScope } from "../tasks/service.js";
import { getScheduleQueue, nextRunAt, scheduleJobId } from "./queue.js";

const createSchema = z.object({
  sessionId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(4000),
  freq: z.enum(["once", "daily", "weekly"]),
  runAt: z.string().datetime({ offset: true }).optional(),
});

export const schedulesRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    try {
      const scope = await resolveScope(user.id, c.req.query("sessionId") ?? null);
      const items = await prisma.workspaceSchedule.findMany({
        where: artifactWhere(user.id, scope),
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return c.json({ items });
    } catch {
      return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
    }
  })
  .post("/", async (c) => {
    const user = c.get("user");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid schedule payload" }, 400);
    const scope = await resolveScope(user.id, parsed.data.sessionId).catch(() => null);
    if (scope === null && parsed.data.sessionId) {
      const exists = await prisma.chatSession.findFirst({
        where: { id: parsed.data.sessionId, userId: user.id },
        select: { id: true },
      });
      if (!exists) return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
    }
    const firstRun = parsed.data.runAt ? new Date(parsed.data.runAt) : nextRunAt(parsed.data.freq);
    const schedule = await prisma.workspaceSchedule.create({
      data: {
        userId: user.id,
        projectId: scope,
        title: parsed.data.title,
        prompt: parsed.data.prompt,
        freq: parsed.data.freq,
        nextRunAt: firstRun,
      },
      select: { id: true, title: true, freq: true, nextRunAt: true, status: true },
    });
    await getScheduleQueue()
      .add(
        "run",
        { scheduleId: schedule.id, userId: user.id, projectId: scope },
        { jobId: scheduleJobId(schedule.id), delay: Math.max(0, firstRun.getTime() - Date.now()) },
      )
      .catch(() => undefined);
    return c.json(schedule, 201);
  })
  .delete("/:id", async (c) => {
    const user = c.get("user");
    const existing = await prisma.workspaceSchedule.findFirst({
      where: { id: c.req.param("id"), userId: user.id },
      select: { id: true },
    });
    if (!existing) return c.json({ error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" }, 404);
    await prisma.workspaceSchedule.update({
      where: { id: existing.id },
      data: { status: "cancelled" },
    });
    await getScheduleQueue().remove(scheduleJobId(existing.id)).catch(() => undefined);
    return c.json({ ok: true });
  });
