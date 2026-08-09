import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { getImageStore, type GeneratedImageRecord } from "./service.js";

function requireQueryId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Metadata view without the r2Key (never exposed to clients). */
function toImageMetadata(image: GeneratedImageRecord) {
  const { r2Key: _r2Key, createdAt, ...rest } = image;
  return { ...rest, createdAt: createdAt.toISOString() };
}

export const imagesRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    const sessionId = requireQueryId(c.req.query("sessionId"));
    const projectId = requireQueryId(c.req.query("projectId"));
    const scope = c.req.query("scope");
    const store = getImageStore();

    if (sessionId) {
      const images = await store.listSessionImages({
        sessionId,
        userId: user.id,
      });
      return c.json({ images: images.map(toImageMetadata) });
    }

    if (projectId) {
      const images = await store.listProjectImages({
        projectId,
        userId: user.id,
      });
      return c.json({ images: images.map(toImageMetadata) });
    }

    if (scope === "user") {
      const images = await store.listUserImages(user.id);
      return c.json({ images: images.map(toImageMetadata) });
    }

    return c.json(
      { error: "sessionId, projectId, or scope=user is required" },
      400,
    );
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    const store = getImageStore();

    const image = await store.getImage(c.req.param("id"));
    if (!image) {
      return c.json({ error: "Image not found" }, 404);
    }

    const allowed = await store.assertImageAccess({ userId: user.id, image });
    if (!allowed) {
      return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403);
    }

    try {
      const data = await store.getObjectBuffer(image.r2Key);
      return c.body(new Uint8Array(data), 200, {
        "Content-Type": image.mediaType,
        "Cache-Control": "private, max-age=3600",
      });
    } catch (error) {
      console.error("[images] R2 fetch failed", { imageId: image.id, error });
      return c.json({ error: "Image not found" }, 404);
    }
  })
  .get("/context", async (c) => {
    const user = c.get("user");
    const sessionId = requireQueryId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const images = await getImageStore().listSessionImageContexts({
      sessionId,
      userId: user.id,
    });
    return c.json({ images: images.map(toImageMetadata) });
  })
  .post("/context", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as {
      sessionId?: unknown;
      imageId?: unknown;
    } | null;
    const sessionId =
      typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    const imageId =
      typeof body?.imageId === "string" ? body.imageId.trim() : "";
    if (!sessionId || !imageId) {
      return c.json(
        { error: "sessionId and imageId are required" },
        400,
      );
    }

    const added = await getImageStore().addSessionImageContext({
      userId: user.id,
      sessionId,
      imageId,
    });
    if (!added) {
      return c.json({ error: "Image not found in this session" }, 404);
    }
    return c.json({ ok: true });
  })
  .delete("/context/:imageId", async (c) => {
    const user = c.get("user");
    const sessionId = requireQueryId(c.req.query("sessionId"));
    const imageId = c.req.param("imageId");
    if (!sessionId || !imageId) {
      return c.json(
        { error: "sessionId is required" },
        400,
      );
    }
    await getImageStore().removeSessionImageContext({
      userId: user.id,
      sessionId,
      imageId,
    });
    return c.json({ ok: true });
  });
