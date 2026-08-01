import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import {
  createDocumentUpload,
  DocumentStorageQuotaError,
  getDocumentStatus,
  getUserStorageUsage,
  listSessionDocuments,
} from "./service.js";

function requireSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return sessionId.length > 0 ? sessionId : null;
}

export const documentsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/storage", async (c) => {
    const user = c.get("user");
    const usage = await getUserStorageUsage(user.id);
    return c.json(usage);
  })
  .get("/", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const documents = await listSessionDocuments(sessionId, user.id);
    return c.json(documents);
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const document = await getDocumentStatus({
      userId: user.id,
      sessionId,
      documentId: c.req.param("id"),
    });

    if (!document) {
      return c.json({ error: "Document not found" }, 404);
    }

    return c.json(document);
  })
  .post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.parseBody();
    const sessionId = requireSessionId(body.sessionId);
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

    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      if (buffer.byteLength === 0) {
        return c.json({ error: "File is empty" }, 400);
      }
      const result = await createDocumentUpload({
        userId: user.id,
        sessionId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        data: buffer,
      });
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof DocumentStorageQuotaError) {
        return c.json(
          {
            error: error.message,
            code: error.code,
            usedBytes: error.usedBytes,
            maxBytes: error.maxBytes,
            fileBytes: error.fileBytes,
          },
          413,
        );
      }
      const message =
        error instanceof Error ? error.message : "Upload failed";
      return c.json({ error: message }, 400);
    }
  });
