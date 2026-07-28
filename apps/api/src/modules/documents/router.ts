import { Hono } from "hono";
import {
  createDocumentUpload,
  getDocumentStatus,
  listSessionDocuments,
} from "./service.js";

function requireSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return sessionId.length > 0 ? sessionId : null;
}

export const documentsRouter = new Hono()
  .get("/", async (c) => {
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const documents = await listSessionDocuments(sessionId);
    return c.json(documents);
  })
  .get("/:id", async (c) => {
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const document = await getDocumentStatus({
      sessionId,
      documentId: c.req.param("id"),
    });

    if (!document) {
      return c.json({ error: "Document not found" }, 404);
    }

    return c.json(document);
  })
  .post("/", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = requireSessionId(body.sessionId);
    const file = body.file;

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    if (!(file instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }

    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const result = await createDocumentUpload({
        sessionId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        data: buffer,
      });
      return c.json(result, 202);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Upload failed";
      return c.json({ error: message }, 400);
    }
  });
