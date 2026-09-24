import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import {
  getArtifact,
  isArtifactType,
  listArtifacts,
  resolveSessionScope,
  updateImageCaption,
} from "./service.js";

export const artifactsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    const typeRaw = c.req.query("type");
    if (typeRaw !== undefined && !isArtifactType(typeRaw)) {
      return c.json({ error: "Unknown artifact type" }, 400);
    }
    const sessionId = c.req.query("sessionId") ?? null;
    let scope: string | null;
    try {
      scope = await resolveSessionScope({ userId: user.id, sessionId });
    } catch {
      return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
    }
    const result = await listArtifacts({
      userId: user.id,
      sessionProjectId: scope,
      ...(typeRaw !== undefined ? { type: typeRaw } : {}),
      ...(c.req.query("q") ? { q: c.req.query("q")! } : {}),
    });
    return c.json(result);
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    const typeRaw = c.req.query("type");
    if (!isArtifactType(typeRaw)) {
      return c.json({ error: "type query is required" }, 400);
    }
    const sessionId = c.req.query("sessionId") ?? null;
    let scope: string | null;
    try {
      scope = await resolveSessionScope({ userId: user.id, sessionId });
    } catch {
      return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
    }
    const artifact = await getArtifact({
      userId: user.id,
      sessionProjectId: scope,
      type: typeRaw,
      id: c.req.param("id"),
    });
    if (!artifact) {
      return c.json({ error: "Artifact not found", code: "ARTIFACT_NOT_FOUND" }, 404);
    }
    return c.json({ artifact });
  })
  .patch("/images/:id", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as { caption?: unknown } | null;
    if (typeof body?.caption !== "string") {
      return c.json({ error: "caption is required" }, 400);
    }
    try {
      const updated = await updateImageCaption({
        userId: user.id,
        imageId: c.req.param("id"),
        caption: body.caption,
      });
      return c.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update failed";
      if (message === "Image not found") {
        return c.json({ error: message, code: "IMAGE_NOT_FOUND" }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });
