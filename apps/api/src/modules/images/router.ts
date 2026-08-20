import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { getImageStore, type GeneratedImageRecord } from "./service.js";

function requireQueryId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Metadata view without the r2Key (never exposed to clients). The record
 * spread automatically carries the new source/sourceUrl fields to clients.
 */
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
  .post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.parseBody();
    const sessionId = requireQueryId(body.sessionId);
    const file = body.file;

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    if (!(file instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }
    if (file.size === 0) {
      return c.json({ error: "File is empty" }, 400);
    }

    const mediaType = file.type || "image/png";
    if (!mediaType.startsWith("image/")) {
      return c.json({ error: "Only image files can be uploaded here" }, 400);
    }

    const width = Number(body.width);
    const height = Number(body.height);
    const projectIdRaw = body.projectId;
    const projectId =
      typeof projectIdRaw === "string" && projectIdRaw.trim()
        ? projectIdRaw.trim()
        : null;

    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      if (buffer.byteLength === 0) {
        return c.json({ error: "File is empty" }, 400);
      }
      const store = getImageStore();
      if (!(await store.sessionOwnedByUser({ sessionId, userId: user.id }))) {
        return c.json({ error: "Session not found" }, 404);
      }
      const image = await store.saveGeneratedImage({
        userId: user.id,
        sessionId,
        projectId,
        buffer,
        mediaType,
        modelId: "user-upload",
        prompt: file.name || "Uploaded image",
        width: Number.isFinite(width) && width > 0 ? width : 0,
        height: Number.isFinite(height) && height > 0 ? height : 0,
      });
      return c.json({ image: toImageMetadata(image) }, 201);
    } catch (error) {
      console.error("[images] upload failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Could not upload image" }, 500);
    }
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
  });
