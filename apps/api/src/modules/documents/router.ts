import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { ProjectMembershipError } from "../chat/chat-session.js";
import {
  createDocumentUpload,
  deleteUserDocument,
  DocumentConfirmRequiredError,
  DocumentNotFoundError,
  DocumentProjectMismatchError,
  DocumentStorageQuotaError,
  getDocumentPreview,
  getDocumentStatus,
  getUserStorageUsage,
  linkDocumentsToSession,
  listSessionDocuments,
  listUserDocuments,
  unlinkDocumentFromSession,
} from "./service.js";

function requireSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return sessionId.length > 0 ? sessionId : null;
}

function parseConfirm(value: unknown): boolean {
  if (value === true || value === "true" || value === "1") return true;
  return false;
}

function parseDocumentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((id) => id.trim())
    .filter(Boolean);
}

export const documentsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/storage", async (c) => {
    const user = c.get("user");
    const usage = await getUserStorageUsage(user.id);
    return c.json(usage);
  })
  .get("/library", async (c) => {
    const user = c.get("user");
    const scopeRaw = c.req.query("scope");
    const scope =
      scopeRaw === "browser" || scopeRaw === "attach" ? scopeRaw : "attach";
    const projectIdRaw = c.req.query("projectId");
    const projectId =
      typeof projectIdRaw === "string" && projectIdRaw.trim()
        ? projectIdRaw.trim()
        : undefined;

    const page = await listUserDocuments({
      userId: user.id,
      query: c.req.query("q") ?? undefined,
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
      scope,
      projectId: projectId ?? null,
    });
    return c.json(page);
  })
  .post("/links", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const sessionId = requireSessionId(body?.sessionId);
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const documentIds = parseDocumentIds(body?.documentIds);
    if (documentIds.length === 0) {
      return c.json({ error: "documentIds is required" }, 400);
    }

    const result = await linkDocumentsToSession({
      userId: user.id,
      sessionId,
      documentIds,
    });
    return c.json(result);
  })
  .delete("/links", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const sessionId = requireSessionId(body?.sessionId);
    const documentId =
      typeof body?.documentId === "string" ? body.documentId.trim() : "";

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    if (!documentId) {
      return c.json({ error: "documentId is required" }, 400);
    }

    const result = await unlinkDocumentFromSession({
      userId: user.id,
      sessionId,
      documentId,
    });
    return c.json(result);
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
  .get("/:id/preview", async (c) => {
    const user = c.get("user");
    const pageIndexRaw = c.req.query("pageIndex");
    const pageIndex =
      pageIndexRaw !== undefined && pageIndexRaw !== ""
        ? Number(pageIndexRaw)
        : undefined;
    const pageLimitRaw = c.req.query("pageLimit");
    const pageLimit =
      pageLimitRaw !== undefined && pageLimitRaw !== ""
        ? Number(pageLimitRaw)
        : undefined;

    const preview = await getDocumentPreview({
      userId: user.id,
      documentId: c.req.param("id"),
      ...(Number.isInteger(pageIndex) ? { pageIndex } : {}),
      ...(Number.isInteger(pageLimit) ? { pageLimit } : {}),
    });

    if (!preview) {
      return c.json({ error: "Document not found" }, 404);
    }

    return c.json(preview);
  })
  .delete("/:id", async (c) => {
    const user = c.get("user");
    const confirmQuery = c.req.query("confirm");
    let confirmBody = false;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      confirmBody = parseConfirm(body?.confirm);
    } catch {
      // DELETE may have empty body
    }
    const confirm = parseConfirm(confirmQuery) || confirmBody;

    try {
      const result = await deleteUserDocument({
        userId: user.id,
        documentId: c.req.param("id"),
        confirm,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      if (error instanceof DocumentConfirmRequiredError) {
        return c.json({ error: error.message, code: error.code }, 400);
      }
      throw error;
    }
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));

    const document = await getDocumentStatus({
      userId: user.id,
      documentId: c.req.param("id"),
      ...(sessionId ? { sessionId } : {}),
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
      const projectIdRaw = body.projectId;
      const projectId =
        typeof projectIdRaw === "string" && projectIdRaw.trim()
          ? projectIdRaw.trim()
          : undefined;
      const result = await createDocumentUpload({
        userId: user.id,
        sessionId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        data: buffer,
        projectId,
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
      if (error instanceof DocumentProjectMismatchError) {
        return c.json(
          { error: error.message, code: error.code },
          400,
        );
      }
      if (error instanceof ProjectMembershipError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      const message =
        error instanceof Error ? error.message : "Upload failed";
      return c.json({ error: message }, 400);
    }
  });
