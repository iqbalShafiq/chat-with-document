import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { createReport } from "./store.js";

const citationSchema = z.object({
  claim: z.string().min(1).max(500),
  documentId: z.string().optional(),
  pageIndex: z.number().int().min(0).optional(),
  webBundleId: z.string().optional(),
  url: z.string().max(2000).optional(),
});

const createReportSchema = z.object({
  sessionId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  markdown: z.string().min(1).max(100_000),
  svgAssets: z.array(z.string().max(200_000)).max(10).optional(),
  citationMap: z.array(citationSchema).max(100).optional(),
});

export const reportsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .post("/", async (c) => {
    const user = c.get("user");
    const parsed = createReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid report payload" }, 400);
    try {
      const result = await createReport({ userId: user.id, ...parsed.data });
      return c.json(result, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Create failed";
      if (message === "Session not found") {
        return c.json({ error: message, code: "SESSION_NOT_FOUND" }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });
