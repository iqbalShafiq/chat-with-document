import {
  DOCUMENT_ID_EXAMPLE,
  ISO_EXAMPLE,
  PROJECT_ID_EXAMPLE,
  SESSION_ID_EXAMPLE,
  UUID_EXAMPLE,
  documentLibraryItemSchema,
  exampleSessionDocument,
  sessionDocumentSchema,
  storageUsageSchema,
} from "../components.js";
import {
  badRequest,
  bearerOrCookie,
  jsonResponse,
  jsonSchema,
  notFound,
  unauthorized,
} from "../helpers.js";

const libraryPageSchema = {
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: documentLibraryItemSchema },
    nextCursor: { type: ["string", "null"] },
  },
};

const exampleLibraryItem = {
  ...exampleSessionDocument,
  createdAt: ISO_EXAMPLE,
  originSessionId: SESSION_ID_EXAMPLE,
  projectId: null,
  projectName: null,
};

export const documentsPaths = {
  "/api/documents/storage": {
    get: {
      operationId: "getDocumentStorage",
      tags: ["Documents"],
      summary: "Document storage quota",
      description:
        "Per-user document storage. Cap is 200 MB across all sessions. Used by the upload UI before sending a file.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Current usage.", storageUsageSchema, {
          default: {
            summary: "Under quota",
            value: {
              usedBytes: 12_582_912,
              maxBytes: 209_715_200,
              remainingBytes: 197_132_288,
            },
          },
        }),
        "401": unauthorized,
      },
    },
  },
  "/api/documents/library": {
    get: {
      operationId: "listDocumentLibrary",
      tags: ["Documents"],
      summary: "Browse ready documents",
      description:
        "`scope=attach` (default) is the attach-modal corpus: standalone docs, or a single project when `projectId` is set.\n\n`scope=browser` lists every ready document the user owns (Documents page), optionally filtered by `projectId`.\n\nCursor format is `{isoCreatedAt}|{documentId}`. Default `limit` 20, max 50.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "scope",
          in: "query",
          schema: { type: "string", enum: ["attach", "browser"] },
          example: "attach",
        },
        {
          name: "projectId",
          in: "query",
          schema: { type: "string", format: "uuid" },
          example: PROJECT_ID_EXAMPLE,
        },
        {
          name: "q",
          in: "query",
          schema: { type: "string" },
          example: "quarterly",
        },
        {
          name: "cursor",
          in: "query",
          schema: { type: "string" },
          example: `${ISO_EXAMPLE}|${DOCUMENT_ID_EXAMPLE}`,
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50 },
          example: 20,
        },
      ],
      responses: {
        "200": jsonResponse("A page of ready documents.", libraryPageSchema, {
          default: {
            summary: "One document",
            value: { items: [exampleLibraryItem], nextCursor: null },
          },
        }),
        "401": unauthorized,
      },
    },
  },
  "/api/documents/links": {
    post: {
      operationId: "linkDocumentsToSession",
      tags: ["Documents"],
      summary: "Attach documents to a chat",
      description:
        "Links ready documents the user owns (same corpus as the chat — standalone vs project) to `sessionId`. Returns the full active-document list for that session.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["sessionId", "documentIds"],
            properties: {
              sessionId: { type: "string", format: "uuid" },
              documentIds: {
                type: "array",
                items: { type: "string", format: "uuid" },
              },
            },
          },
          {
            default: {
              summary: "Link one PDF",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                documentIds: [DOCUMENT_ID_EXAMPLE],
              },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Active documents after linking.",
          {
            type: "object",
            required: ["linked"],
            properties: {
              linked: { type: "array", items: sessionDocumentSchema },
            },
          },
          {
            default: {
              summary: "Linked",
              value: { linked: [exampleSessionDocument] },
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
    delete: {
      operationId: "unlinkDocumentFromSession",
      tags: ["Documents"],
      summary: "Detach a document from a chat",
      description:
        "Removes the session link. The document itself stays in the library. Body must include `sessionId` and `documentId`.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["sessionId", "documentId"],
            properties: {
              sessionId: { type: "string", format: "uuid" },
              documentId: { type: "string", format: "uuid" },
            },
          },
          {
            default: {
              summary: "Unlink",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                documentId: DOCUMENT_ID_EXAMPLE,
              },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Unlink result.",
          {
            type: "object",
            required: ["ok", "removed"],
            properties: {
              ok: { type: "boolean" },
              removed: { type: "boolean" },
            },
          },
          {
            removed: { summary: "Link existed", value: { ok: true, removed: true } },
            missing: {
              summary: "Nothing to remove",
              value: { ok: true, removed: false },
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/documents": {
    get: {
      operationId: "listSessionDocuments",
      tags: ["Documents"],
      summary: "List documents attached to a session",
      description:
        "Ready documents linked to the chat. Project chats only see that project's corpus.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "sessionId",
          in: "query",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse(
          "Active documents.",
          { type: "array", items: sessionDocumentSchema },
          {
            empty: { summary: "None attached", value: [] },
            attached: {
              summary: "One PDF",
              value: [exampleSessionDocument],
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "uploadDocument",
      tags: ["Documents"],
      summary: "Upload a document",
      description:
        "Multipart upload. Fields: `file` (PDF / PNG / JPEG / WebP, max 10 MB), `sessionId` (required), optional `projectId`.\n\nThe file is stored in R2 and queued for ingest (OCR + chunking). Response is `202` with `status: \"queued\"`.\n\n`413 STORAGE_QUOTA_EXCEEDED` when the 200 MB user cap would be crossed.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file", "sessionId"],
              properties: {
                file: { type: "string", format: "binary" },
                sessionId: { type: "string", format: "uuid" },
                projectId: { type: "string", format: "uuid" },
              },
            },
            examples: {
              default: {
                summary: "PDF into a standalone chat",
                value: {
                  file: "(binary)",
                  sessionId: SESSION_ID_EXAMPLE,
                },
              },
            },
          },
        },
      },
      responses: {
        "202": jsonResponse(
          "Accepted for ingest.",
          {
            type: "object",
            required: ["id", "filename", "status", "sizeBytes"],
            properties: {
              id: { type: "string", format: "uuid" },
              filename: { type: "string" },
              status: { type: "string", const: "queued" },
              sizeBytes: { type: "integer" },
            },
          },
          {
            default: {
              summary: "Queued",
              value: {
                id: DOCUMENT_ID_EXAMPLE,
                filename: "quarterly-report.pdf",
                status: "queued",
                sizeBytes: 245760,
              },
            },
          },
        ),
        "400": badRequest({ error: "file is required" }),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
        "413": jsonResponse(
          "User storage quota exceeded.",
          {
            type: "object",
            required: ["error", "code", "usedBytes", "maxBytes", "fileBytes"],
            properties: {
              error: { type: "string" },
              code: { type: "string" },
              usedBytes: { type: "integer" },
              maxBytes: { type: "integer" },
              fileBytes: { type: "integer" },
            },
          },
          {
            default: {
              summary: "Over quota",
              value: {
                error:
                  "Storage limit exceeded (200.1 MB / 200.0 MB). Delete documents or free space before uploading.",
                code: "STORAGE_QUOTA_EXCEEDED",
                usedBytes: 209_000_000,
                maxBytes: 209_715_200,
                fileBytes: 245760,
              },
            },
          },
        ),
      },
    },
  },
  "/api/documents/{id}": {
    get: {
      operationId: "getDocumentStatus",
      tags: ["Documents"],
      summary: "Get document ingest status",
      description:
        "Poll after upload. Status moves `uploading` → `queued` → `processing` → `ready` (or `error`). Optional `sessionId` restricts the lookup to that chat.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: DOCUMENT_ID_EXAMPLE,
        },
        {
          name: "sessionId",
          in: "query",
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse(
          "Document status.",
          {
            type: "object",
            required: ["id", "filename", "status", "pageCount", "sizeBytes"],
            properties: {
              id: { type: "string" },
              filename: { type: "string" },
              status: { type: "string" },
              pageCount: { type: "integer" },
              errorMessage: { type: ["string", "null"] },
              firstPageSummary: { type: ["string", "null"] },
              sizeBytes: { type: "integer" },
            },
          },
          {
            queued: {
              summary: "Still ingesting",
              value: {
                id: DOCUMENT_ID_EXAMPLE,
                filename: "quarterly-report.pdf",
                status: "queued",
                pageCount: 0,
                errorMessage: null,
                firstPageSummary: null,
                sizeBytes: 245760,
              },
            },
            ready: {
              summary: "Ready",
              value: {
                id: DOCUMENT_ID_EXAMPLE,
                filename: "quarterly-report.pdf",
                status: "ready",
                pageCount: 8,
                errorMessage: null,
                firstPageSummary: "Q3 revenue grew 12% year over year.",
                sizeBytes: 245760,
              },
            },
          },
        ),
        "401": unauthorized,
        "404": notFound({ error: "Document not found" }),
      },
    },
    delete: {
      operationId: "deleteDocument",
      tags: ["Documents"],
      summary: "Permanently delete a document",
      description:
        "Requires confirmation via `?confirm=true` or JSON `{ \"confirm\": true }`. Deletes the DB row, R2 object, page images, and Qdrant chunks.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: DOCUMENT_ID_EXAMPLE,
        },
        {
          name: "confirm",
          in: "query",
          schema: { type: "string", enum: ["true", "1"] },
          example: "true",
        },
      ],
      requestBody: {
        required: false,
        content: jsonSchema(
          {
            type: "object",
            properties: { confirm: { type: "boolean" } },
          },
          { default: { summary: "Confirm in body", value: { confirm: true } } },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Deleted.",
          {
            type: "object",
            required: ["deleted"],
            properties: { deleted: { type: "boolean", const: true } },
          },
          { default: { summary: "Deleted", value: { deleted: true } } },
        ),
        "400": badRequest({
          error: "confirm=true is required to delete a document",
          code: "CONFIRM_REQUIRED",
        }),
        "401": unauthorized,
        "404": notFound({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }),
      },
    },
  },
  "/api/documents/{id}/preview": {
    get: {
      operationId: "getDocumentPreview",
      tags: ["Documents"],
      summary: "Preview document pages",
      description:
        "Returns summaries + markdown for a window of pages. `pageIndex` is the first page (0-based). `pageLimit` defaults to 1 and is capped at 5.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: DOCUMENT_ID_EXAMPLE,
        },
        {
          name: "pageIndex",
          in: "query",
          schema: { type: "integer", minimum: 0 },
          example: 0,
        },
        {
          name: "pageLimit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 5 },
          example: 1,
        },
      ],
      responses: {
        "200": jsonResponse(
          "Preview payload.",
          {
            type: "object",
            required: [
              "id",
              "filename",
              "mimeType",
              "pageCount",
              "sizeBytes",
              "pages",
            ],
            properties: {
              id: { type: "string" },
              filename: { type: "string" },
              mimeType: { type: "string" },
              pageCount: { type: "integer" },
              sizeBytes: { type: "integer" },
              firstPageSummary: { type: "string" },
              summary: { type: ["string", "null"] },
              pages: {
                type: "array",
                items: {
                  type: "object",
                  required: ["pageIndex", "summary", "rawMarkdown", "images"],
                  properties: {
                    pageIndex: { type: "integer" },
                    summary: { type: "string" },
                    rawMarkdown: { type: "string" },
                    images: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["id", "mediaType"],
                        properties: {
                          id: { type: "string" },
                          mediaType: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            default: {
              summary: "First page",
              value: {
                id: DOCUMENT_ID_EXAMPLE,
                filename: "quarterly-report.pdf",
                mimeType: "application/pdf",
                pageCount: 8,
                sizeBytes: 245760,
                firstPageSummary: "Q3 revenue grew 12% year over year.",
                summary: "Full-document summary…",
                pages: [
                  {
                    pageIndex: 0,
                    summary: "Cover + headline numbers.",
                    rawMarkdown: "# Q3 Report\n\nRevenue +12% YoY.",
                    images: [{ id: UUID_EXAMPLE, mediaType: "image/png" }],
                  },
                ],
              },
            },
          },
        ),
        "401": unauthorized,
        "404": notFound({ error: "Document not found" }),
      },
    },
  },
  "/api/documents/{id}/pages/{pageIndex}/images/{imageId}": {
    get: {
      operationId: "getDocumentPageImage",
      tags: ["Documents"],
      summary: "Download a page image",
      description:
        "Binary image extracted from a document page. `Cache-Control: private, max-age=3600`.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: DOCUMENT_ID_EXAMPLE,
        },
        {
          name: "pageIndex",
          in: "path",
          required: true,
          schema: { type: "integer", minimum: 0 },
          example: 0,
        },
        {
          name: "imageId",
          in: "path",
          required: true,
          schema: { type: "string" },
          example: UUID_EXAMPLE,
        },
      ],
      responses: {
        "200": {
          description: "Image bytes.",
          content: {
            "image/png": {
              schema: { type: "string", format: "binary" },
              examples: {
                default: { summary: "PNG page crop", value: "(binary)" },
              },
            },
            "image/jpeg": {
              schema: { type: "string", format: "binary" },
              examples: {
                default: { summary: "JPEG page crop", value: "(binary)" },
              },
            },
          },
        },
        "401": unauthorized,
        "404": notFound({ error: "Image not found" }),
      },
    },
  },
};
