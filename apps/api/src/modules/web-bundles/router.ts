import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import { artifactWhere } from "../artifacts/scope.js";

const freezeSchema = z.object({
  sessionId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  sources: z
    .array(
      z.object({
        url: z.string().max(2000),
        title: z.string().max(300).optional(),
        snapshot: z.string().max(20_000).optional(),
        imageUrl: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const webBundlesRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .post("/freeze", async (c) => {
    const user = c.get("user");
    const parsed = freezeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid bundle payload" }, 400);
    const session = await prisma.chatSession.findFirst({
      where: { id: parsed.data.sessionId, userId: user.id },
      select: { projectId: true },
    });
    if (!session) return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
    const scope = artifactWhere(user.id, session.projectId ?? null);
    const bundle = await prisma.webBundle.create({
      data: {
        userId: scope.userId,
        projectId: scope.projectId,
        title: parsed.data.title,
        sources: parsed.data.sources,
      },
      select: { id: true, title: true },
    });
    return c.json(bundle, 201);
  });
