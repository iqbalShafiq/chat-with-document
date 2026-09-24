import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import { putObject } from "../../lib/r2.js";
import { chartSpecToSvg } from "./snapshot.js";

const snapshotSchema = z.object({
  sessionId: z.string().min(1).max(120),
  caption: z.string().trim().min(1).max(280).optional(),
  chart: z.unknown(),
});

export const chartsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .post("/snapshot", async (c) => {
    const user = c.get("user");
    const parsed = snapshotSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid chart payload" }, 400);
    const session = await prisma.chatSession.findFirst({
      where: { id: parsed.data.sessionId, userId: user.id },
      select: { id: true, projectId: true },
    });
    if (!session) return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
    let svg: string;
    try {
      svg = chartSpecToSvg(parsed.data.chart as never);
    } catch {
      return c.json({ error: "Invalid chart spec" }, 400);
    }
    const bytes = new TextEncoder().encode(svg);
    const r2Key = `images/${user.id}/${randomUUID()}.svg`;
    await putObject(r2Key, bytes, "image/svg+xml");
    const image = await prisma.generatedImage.create({
      data: {
        userId: user.id,
        sessionId: parsed.data.sessionId,
        projectId: session.projectId ?? null,
        r2Key,
        mediaType: "image/svg+xml",
        width: 640,
        height: 360,
        modelId: "chart-snapshot",
        prompt: parsed.data.caption ?? "chart snapshot",
        caption: parsed.data.caption ?? "chart snapshot",
        source: "chart",
      },
      select: { id: true, caption: true, sessionId: true, projectId: true, mediaType: true },
    });
    return c.json({ image }, 201);
  });
