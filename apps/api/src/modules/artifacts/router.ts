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
    const body = (await c.req.json().catch(() => null)) as {
      caption?: unknown;
      sessionId?: unknown;
      projectId?: unknown;
    } | null;
    if (typeof body?.caption !== "string") {
      return c.json({ error: "caption is required" }, 400);
    }
    const hasSession = typeof body?.sessionId === "string" && body.sessionId.trim().length > 0;
    const hasProjectScope = body !== null && Object.prototype.hasOwnProperty.call(body, "projectId");
    if (!hasSession && !hasProjectScope) {
      return c.json({ error: "sessionId or projectId is required" }, 400);
    }
    if (
      body?.projectId !== undefined &&
      body?.projectId !== null &&
      typeof body.projectId !== "string"
    ) {
      return c.json({ error: "projectId must be a string or null" }, 400);
    }
    try {
      const updated = await updateImageCaption({
        userId: user.id,
        ...(hasSession ? { sessionId: body!.sessionId as string } : {}),
        ...(hasProjectScope ? { projectId: (body!.projectId as string | null) ?? null } : {}),
        imageId: c.req.param("id"),
        caption: body!.caption as string,
      });
      return c.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update failed";
      if (message === "Image not found" || message === "Session not found") {
        return c.json({ error: message, code: "IMAGE_NOT_FOUND" }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });
