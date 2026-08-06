import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import { removePendingProfileJob } from "./queue.js";
import { getProfilingSettingsPayload, resetProfile } from "./service.js";

export const profilingRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    const payload = await getProfilingSettingsPayload(user.id);
    return c.json(payload);
  })
  .delete("/", async (c) => {
    const user = c.get("user");
    const scopeRaw = c.req.query("scope");
    if (scopeRaw !== "user") {
      return c.json({ error: 'scope must be "user"' }, 400);
    }
    await resetProfile({ kind: "user", userId: user.id });
    await removePendingProfileJob({ kind: "user", userId: user.id });
    return c.json({ ok: true });
  })
  .delete("/projects/:projectId", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) {
      return c.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, 404);
    }

    await resetProfile({ kind: "project", userId: user.id, projectId });
    await removePendingProfileJob({ kind: "project", userId: user.id, projectId });
    return c.json({ ok: true });
  });
