import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./document.js";

const EXPECTED_OPERATIONS: Array<{
  path: string;
  method: string;
  operationId: string;
}> = [
  { path: "/health", method: "get", operationId: "getHealth" },
  { path: "/api/auth/sign-up/email", method: "post", operationId: "signUpEmail" },
  { path: "/api/auth/sign-in/email", method: "post", operationId: "signInEmail" },
  { path: "/api/auth/sign-out", method: "post", operationId: "signOut" },
  { path: "/api/auth/get-session", method: "get", operationId: "getSession" },
  { path: "/api/chat/sessions", method: "get", operationId: "listChatSessions" },
  { path: "/api/chat/sessions", method: "post", operationId: "createChatSession" },
  {
    path: "/api/chat/sessions/draft",
    method: "post",
    operationId: "getOrCreateDraftSession",
  },
  { path: "/api/chat/sessions/{id}", method: "patch", operationId: "renameChatSession" },
  { path: "/api/chat/sessions/{id}", method: "delete", operationId: "deleteChatSession" },
  {
    path: "/api/chat/sessions/mark-read",
    method: "post",
    operationId: "markChatSessionRead",
  },
  { path: "/api/chat", method: "get", operationId: "getChatHistory" },
  { path: "/api/chat", method: "post", operationId: "sendChatMessage" },
  { path: "/api/chat/context-usage", method: "get", operationId: "getContextUsage" },
  {
    path: "/api/chat/{sessionId}/context-snippet",
    method: "get",
    operationId: "getContextSnippet",
  },
  {
    path: "/api/chat/{sessionId}/context-snippet",
    method: "put",
    operationId: "upsertContextSnippet",
  },
  {
    path: "/api/chat/context-snippet/{snippetId}",
    method: "delete",
    operationId: "deleteContextSnippet",
  },
  { path: "/api/chat/runs", method: "get", operationId: "listActiveRuns" },
  { path: "/api/chat/run-status", method: "get", operationId: "getRunStatus" },
  { path: "/api/chat/session-state", method: "get", operationId: "getSessionState" },
  { path: "/api/chat/truncate", method: "post", operationId: "truncateChatMemory" },
  { path: "/api/chat/stop", method: "post", operationId: "stopChatRun" },
  { path: "/api/chat/steer", method: "post", operationId: "steerChatRun" },
  { path: "/api/chat/queue/sync", method: "post", operationId: "syncChatQueue" },
  { path: "/api/chat/capabilities", method: "get", operationId: "getChatCapabilities" },
  {
    path: "/api/chat/approvals/{approvalId}/decision",
    method: "post",
    operationId: "decideToolApproval",
  },
  {
    path: "/api/chat/clarifications/{id}/response",
    method: "post",
    operationId: "answerClarification",
  },
  { path: "/api/documents/storage", method: "get", operationId: "getDocumentStorage" },
  { path: "/api/documents/library", method: "get", operationId: "listDocumentLibrary" },
  { path: "/api/documents/links", method: "post", operationId: "linkDocumentsToSession" },
  {
    path: "/api/documents/links",
    method: "delete",
    operationId: "unlinkDocumentFromSession",
  },
  { path: "/api/documents", method: "get", operationId: "listSessionDocuments" },
  { path: "/api/documents", method: "post", operationId: "uploadDocument" },
  { path: "/api/documents/{id}", method: "get", operationId: "getDocumentStatus" },
  { path: "/api/documents/{id}", method: "delete", operationId: "deleteDocument" },
  {
    path: "/api/documents/{id}/preview",
    method: "get",
    operationId: "getDocumentPreview",
  },
  {
    path: "/api/documents/{id}/pages/{pageIndex}/images/{imageId}",
    method: "get",
    operationId: "getDocumentPageImage",
  },
  { path: "/api/images", method: "get", operationId: "listImages" },
  { path: "/api/images", method: "post", operationId: "uploadImage" },
  { path: "/api/images/context", method: "get", operationId: "listSessionImageContext" },
  { path: "/api/images/context", method: "post", operationId: "pinSessionImageContext" },
  {
    path: "/api/images/context/{imageId}",
    method: "delete",
    operationId: "unpinSessionImageContext",
  },
  { path: "/api/images/{id}", method: "get", operationId: "getImageBytes" },
  { path: "/api/models", method: "get", operationId: "listModels" },
  { path: "/api/projects", method: "get", operationId: "listProjects" },
  { path: "/api/projects", method: "post", operationId: "createProject" },
  { path: "/api/projects/{id}", method: "get", operationId: "getProject" },
  { path: "/api/projects/{id}", method: "patch", operationId: "updateProject" },
  { path: "/api/projects/{id}", method: "delete", operationId: "deleteProject" },
  { path: "/api/projects/{id}/open", method: "post", operationId: "openProject" },
  { path: "/api/profiling", method: "get", operationId: "getProfilingSettings" },
  { path: "/api/profiling", method: "delete", operationId: "resetUserProfile" },
  {
    path: "/api/profiling/projects/{projectId}",
    method: "delete",
    operationId: "resetProjectProfile",
  },
  { path: "/api/usage/summary", method: "get", operationId: "getUsageSummary" },
];

function mediaHasExample(media: unknown): boolean {
  if (!media || typeof media !== "object") return false;
  const record = media as Record<string, unknown>;
  if (record.example !== undefined) return true;
  if (record.examples && typeof record.examples === "object") {
    return Object.keys(record.examples).length > 0;
  }
  return false;
}

function contentHasExample(content: unknown): boolean {
  if (!content || typeof content !== "object") return false;
  return Object.values(content as Record<string, unknown>).some(mediaHasExample);
}

describe("OpenAPI document", () => {
  const doc = buildOpenApiDocument({ serverUrl: "http://localhost:3001" });

  it("is OpenAPI 3.1 with both security schemes", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
    expect(doc.components.securitySchemes.cookieAuth).toBeDefined();
  });

  it("documents every public operation", () => {
    for (const expected of EXPECTED_OPERATIONS) {
      const item = doc.paths[expected.path];
      expect(item, `missing path ${expected.path}`).toBeDefined();
      const operation = item?.[expected.method] as
        | { operationId?: string }
        | undefined;
      expect(operation, `${expected.method.toUpperCase()} ${expected.path}`).toBeDefined();
      expect(operation?.operationId).toBe(expected.operationId);
    }
  });

  it("gives every operation a summary, description, and examples", () => {
    const missing: string[] = [];

    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, raw] of Object.entries(item)) {
        const op = raw as {
          summary?: string;
          description?: string;
          requestBody?: { content?: unknown };
          responses?: Record<string, { content?: unknown }>;
        };
        const label = `${method.toUpperCase()} ${path}`;
        if (!op.summary) missing.push(`${label}: missing summary`);
        if (!op.description) missing.push(`${label}: missing description`);
        if (op.requestBody && !contentHasExample(op.requestBody.content)) {
          missing.push(`${label}: request body has no example`);
        }
        for (const [status, response] of Object.entries(op.responses ?? {})) {
          if (!contentHasExample(response.content)) {
            missing.push(`${label}: ${status} has no example`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
