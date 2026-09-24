import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import { createTask, listTasks, resolveScope, updateTask } from "./service.js";
const createSchema = z.object({
  sessionId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  addSubtasks: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
});

const updateSchema = z.object({
  sessionId: z.string().min(1).max(120),
  status: z.enum(["inbox", "doing", "done"]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  addSubtasks: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  toggleSubtasks: z
    .array(z.object({ id: z.string().min(1).max(120), done: z.boolean() }))
    .max(50)
    .optional(),
  removeSubtasks: z.array(z.string().min(1).max(120)).max(50).optional(),
});

export const tasksRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.query("sessionId") ?? null;
    try {
      const scope = await resolveScope(user.id, sessionId);
      return c.json(await listTasks(user.id, scope));
    } catch {
      return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
    }
  })
  .post("/", async (c) => {
    const user = c.get("user");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Title must be 1-200 characters." }, 400);
    try {
      const task = await createTask({ userId: user.id, ...parsed.data });
      return c.json(task, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Create failed";
      if (message === "Session not found") {
        return c.json({ error: message, code: "SESSION_NOT_FOUND" }, 404);
      }
      return c.json({ error: message }, 400);
    }
  })
  .patch("/:id", async (c) => {
    const user = c.get("user");
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (
      !parsed.success ||
      (parsed.data.status === undefined &&
        parsed.data.title === undefined &&
        parsed.data.description === undefined &&
        parsed.data.addSubtasks === undefined &&
        parsed.data.toggleSubtasks === undefined &&
        parsed.data.removeSubtasks === undefined)
    ) {
      return c.json({ error: "Nothing to update." }, 400);
    }
    try {
      return c.json(
        await updateTask({ userId: user.id, id: c.req.param("id"), ...parsed.data }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update failed";
      if (message === "Task not found" || message === "Session not found") {
        return c.json({ error: message, code: "TASK_NOT_FOUND" }, 404);
      }
      return c.json({ error: message }, 400);
    }
  })
  .delete("/:id", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.query("sessionId") ?? "";
    if (!sessionId.trim()) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    let scope: string | null;
    try {
      scope = await resolveScope(user.id, sessionId);
    } catch {
      return c.json({ error: "Session not found", code: "TASK_NOT_FOUND" }, 404);
    }
    const existing = await prisma.workspaceTask.findFirst({
      where: { id: c.req.param("id"), userId: user.id, projectId: scope },
      select: { id: true },
    });
    if (!existing) {
      return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
    }
    await prisma.workspaceTask.delete({ where: { id: existing.id } });
    return c.json({ ok: true });
  });
