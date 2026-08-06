export const API_BASE = "http://localhost:3001";

export class ApiAuthError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "ApiAuthError";
  }
}

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    credentials: "include",
    headers: init?.headers,
  });

  if (response.status === 401) {
    throw new ApiAuthError();
  }

  return response;
}

export type SessionListItem = {
  sessionId: string;
  updatedAt: string;
  title: string;
  projectId?: string | null;
};

export type SessionListPage = {
  items: SessionListItem[];
  nextCursor: string | null;
};

export async function listSessions(input?: {
  cursor?: string | null;
  limit?: number;
  /** When set, list only that project's chats. When omitted, standalone only. */
  projectId?: string | null;
}): Promise<SessionListPage> {
  const params = new URLSearchParams();
  if (input?.cursor) params.set("cursor", input.cursor);
  if (input?.limit) params.set("limit", String(input.limit));
  if (input?.projectId) params.set("projectId", input.projectId);
  const qs = params.toString();
  const response = await apiFetch(
    `${API_BASE}/api/chat/sessions${qs ? `?${qs}` : ""}`,
  );
  if (!response.ok) {
    throw new Error("Failed to load sessions");
  }

  const data: unknown = await response.json();

  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as SessionListPage).items)
  ) {
    const page = data as SessionListPage;
    return {
      items: page.items.filter(
        (item): item is SessionListItem =>
          !!item &&
          typeof item.sessionId === "string" &&
          typeof item.updatedAt === "string" &&
          typeof item.title === "string",
      ),
      nextCursor:
        typeof page.nextCursor === "string" || page.nextCursor === null
          ? page.nextCursor
          : null,
    };
  }

  throw new Error("Unexpected sessions response shape");
}

export async function createChatSession(input?: {
  sessionId?: string;
  projectId?: string | null;
}): Promise<{
  sessionId: string;
  projectId: string | null;
  title: string | null;
}> {
  const response = await apiFetch(`${API_BASE}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input?.sessionId,
      projectId: input?.projectId ?? null,
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to create chat session");
  }
  return (await response.json()) as {
    sessionId: string;
    projectId: string | null;
    title: string | null;
  };
}

/**
 * Get or create the single empty "New chat" draft for a scope.
 * Server reuses existing empties and prunes duplicates.
 */
export async function getOrCreateEmptyChatSession(input?: {
  projectId?: string | null;
}): Promise<{
  sessionId: string;
  projectId: string | null;
  title: string | null;
  createdAt?: string;
  updatedAt?: string;
}> {
  const response = await apiFetch(`${API_BASE}/api/chat/sessions/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: input?.projectId ?? null,
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to open empty chat draft");
  }
  return (await response.json()) as {
    sessionId: string;
    projectId: string | null;
    title: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
}

// ─── Projects ───────────────────────────────────────────────────────────────

export type ProjectListItem = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  chatCount: number;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectListPage = {
  items: ProjectListItem[];
  nextCursor: string | null;
};

export async function listProjects(input?: {
  query?: string;
  cursor?: string | null;
  limit?: number;
  sort?: "lastOpenedAt" | "updatedAt" | "name";
}): Promise<ProjectListPage> {
  const params = new URLSearchParams();
  if (input?.query?.trim()) params.set("q", input.query.trim());
  if (input?.cursor) params.set("cursor", input.cursor);
  if (input?.limit) params.set("limit", String(input.limit));
  if (input?.sort) params.set("sort", input.sort);
  const qs = params.toString();
  const response = await apiFetch(
    `${API_BASE}/api/projects${qs ? `?${qs}` : ""}`,
  );
  if (!response.ok) throw new Error("Failed to load projects");
  const data = (await response.json()) as ProjectListPage;
  return {
    items: Array.isArray(data.items) ? data.items : [],
    nextCursor:
      typeof data.nextCursor === "string" || data.nextCursor === null
        ? data.nextCursor
        : null,
  };
}

export async function createProject(input: {
  name: string;
  description?: string | null;
}): Promise<ProjectListItem> {
  const response = await apiFetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to create project");
  }
  return (await response.json()) as ProjectListItem;
}

export async function getProject(projectId: string): Promise<ProjectListItem> {
  const response = await apiFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to load project");
  }
  return (await response.json()) as ProjectListItem;
}

export async function openProject(projectId: string): Promise<ProjectListItem> {
  const response = await apiFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/open`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Failed to open project");
  return (await response.json()) as ProjectListItem;
}

export async function updateProject(
  projectId: string,
  input: { name?: string; description?: string | null },
): Promise<ProjectListItem> {
  const response = await apiFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to update project");
  }
  return (await response.json()) as ProjectListItem;
}

export async function deleteProject(
  projectId: string,
): Promise<{ deleted: true; documentCount: number; chatCount: number }> {
  const response = await apiFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}?confirm=true`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to delete project");
  }
  return (await response.json()) as {
    deleted: true;
    documentCount: number;
    chatCount: number;
  };
}

export async function deleteUserDocument(
  documentId: string,
): Promise<{ deleted: true }> {
  const response = await apiFetch(
    `${API_BASE}/api/documents/${encodeURIComponent(documentId)}?confirm=true`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to delete document");
  }
  return (await response.json()) as { deleted: true };
}

export type DocumentStatus =
  | "queued"
  | "uploading"
  | "ocr_processing"
  | "embedding_processing"
  | "ready"
  | "failed";

export interface DocumentStatusResponse {
  id: string;
  filename: string;
  status: DocumentStatus;
  pageCount: number;
  errorMessage: string | null;
  firstPageSummary: string;
  sizeBytes?: number;
}

export interface UploadDocumentResponse {
  id: string;
  filename: string;
  status: DocumentStatus;
  sizeBytes?: number;
}

export type UserStorageUsage = {
  usedBytes: number;
  maxBytes: number;
  remainingBytes: number;
};

const READY_STATUSES = new Set<DocumentStatus>(["ready"]);
const FAILED_STATUSES = new Set<DocumentStatus>(["failed"]);

export function isDocumentReady(status: DocumentStatus) {
  return READY_STATUSES.has(status);
}

export function isDocumentFailed(status: DocumentStatus) {
  return FAILED_STATUSES.has(status);
}

export async function getUserStorageUsage(): Promise<UserStorageUsage> {
  const response = await apiFetch(`${API_BASE}/api/documents/storage`);
  if (!response.ok) {
    throw new Error("Failed to load storage usage");
  }
  return (await response.json()) as UserStorageUsage;
}

export type UserUsageSummary = {
  storage: UserStorageUsage;
  tokens: {
    maxTokens: null;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    composition: {
      inputUncached: number;
      cacheRead: number;
      output: number;
    };
  };
  byModel: Array<{
    model: string;
    requestCount: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byReasoningEffort: Array<{
    reasoningEffort: string;
    requestCount: number;
    totalTokens: number;
  }>;
};

export async function getUserUsageSummary(): Promise<UserUsageSummary> {
  const response = await apiFetch(`${API_BASE}/api/usage/summary`);
  if (!response.ok) {
    throw new Error("Failed to load usage summary");
  }
  return (await response.json()) as UserUsageSummary;
}

export async function uploadDocument(input: {
  sessionId: string;
  file: File;
  projectId?: string | null;
}) {
  const form = new FormData();
  form.append("sessionId", input.sessionId);
  form.append("file", input.file);
  if (input.projectId) {
    form.append("projectId", input.projectId);
  }

  const response = await apiFetch(`${API_BASE}/api/documents`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to upload document");
  }

  return (await response.json()) as UploadDocumentResponse;
}

export async function listSessionDocuments(sessionId: string) {
  const response = await apiFetch(
    `${API_BASE}/api/documents?sessionId=${encodeURIComponent(sessionId)}`,
  );

  if (!response.ok) {
    throw new Error("Failed to load session documents");
  }

  return (await response.json()) as SessionDocument[];
}

export interface SessionDocument {
  id: string;
  filename: string;
  firstPageSummary: string;
  sizeBytes?: number;
  mimeType?: string;
  pageCount?: number;
}

export type UserLibraryDocument = {
  id: string;
  filename: string;
  firstPageSummary: string;
  sizeBytes: number;
  mimeType: string;
  pageCount: number;
  createdAt: string;
  originSessionId: string;
  projectId?: string | null;
  projectName?: string | null;
};

export type UserLibraryPage = {
  items: UserLibraryDocument[];
  nextCursor: string | null;
};

export async function listUserDocuments(input?: {
  query?: string;
  cursor?: string | null;
  limit?: number;
  scope?: "attach" | "browser";
  projectId?: string | null;
}): Promise<UserLibraryPage> {
  const params = new URLSearchParams();
  if (input?.query?.trim()) params.set("q", input.query.trim());
  if (input?.cursor) params.set("cursor", input.cursor);
  if (input?.limit) params.set("limit", String(input.limit));
  if (input?.scope) params.set("scope", input.scope);
  if (input?.projectId) params.set("projectId", input.projectId);
  const qs = params.toString();

  const response = await apiFetch(
    `${API_BASE}/api/documents/library${qs ? `?${qs}` : ""}`,
  );
  if (!response.ok) {
    throw new Error("Failed to load document library");
  }

  const data = (await response.json()) as UserLibraryPage;
  return {
    items: Array.isArray(data.items) ? data.items : [],
    nextCursor:
      typeof data.nextCursor === "string" || data.nextCursor === null
        ? data.nextCursor
        : null,
  };
}

export async function linkDocumentsToSession(input: {
  sessionId: string;
  documentIds: string[];
}): Promise<{ linked: SessionDocument[] }> {
  const response = await apiFetch(`${API_BASE}/api/documents/links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      documentIds: input.documentIds,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to add documents to session");
  }

  return (await response.json()) as { linked: SessionDocument[] };
}

export async function unlinkDocumentFromSession(input: {
  sessionId: string;
  documentId: string;
}): Promise<{ ok: true; removed: boolean }> {
  const response = await apiFetch(`${API_BASE}/api/documents/links`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      documentId: input.documentId,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to remove document from session");
  }

  return (await response.json()) as { ok: true; removed: boolean };
}

export type DocumentPreviewPage = {
  pageIndex: number;
  summary: string;
  rawMarkdown: string;
};

export type DocumentPreview = {
  id: string;
  filename: string;
  mimeType: string;
  pageCount: number;
  sizeBytes: number;
  firstPageSummary: string;
  summary: string;
  pages: DocumentPreviewPage[];
};

export async function getDocumentPreview(input: {
  documentId: string;
  pageIndex?: number;
  pageLimit?: number;
}): Promise<DocumentPreview> {
  const params = new URLSearchParams();
  if (input.pageIndex !== undefined) {
    params.set("pageIndex", String(input.pageIndex));
  }
  if (input.pageLimit !== undefined) {
    params.set("pageLimit", String(input.pageLimit));
  }
  const qs = params.toString();

  const response = await apiFetch(
    `${API_BASE}/api/documents/${encodeURIComponent(input.documentId)}/preview${qs ? `?${qs}` : ""}`,
  );

  if (!response.ok) {
    throw new Error("Failed to load document preview");
  }

  return (await response.json()) as DocumentPreview;
}

export async function getDocumentStatus(input: {
  sessionId: string;
  documentId: string;
}) {
  const response = await apiFetch(
    `${API_BASE}/api/documents/${encodeURIComponent(input.documentId)}?sessionId=${encodeURIComponent(input.sessionId)}`,
  );

  if (!response.ok) {
    throw new Error("Failed to fetch document status");
  }

  return (await response.json()) as DocumentStatusResponse;
}

export async function waitForDocumentReady(input: {
  sessionId: string;
  documentId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStatus?: (status: DocumentStatusResponse) => void;
}) {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const pollIntervalMs = input.pollIntervalMs ?? 1500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getDocumentStatus({
      sessionId: input.sessionId,
      documentId: input.documentId,
    });
    input.onStatus?.(status);

    if (isDocumentReady(status.status)) return status;
    if (isDocumentFailed(status.status)) {
      throw new Error(status.errorMessage ?? "Document processing failed");
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Document processing timed out");
}

export type TruncateSessionMemoryInput = {
  sessionId: string;
  mode: "include" | "exclude";
  memoryPosition?: number;
  clientMessageId?: string;
};

export type TruncateSessionMemoryResult = {
  ok: true;
  deleted: number;
  keptThrough: number;
  resolvedPosition: number | null;
};

export async function truncateSessionMemory(
  input: TruncateSessionMemoryInput,
): Promise<TruncateSessionMemoryResult> {
  const response = await apiFetch(`${API_BASE}/api/chat/truncate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      mode: input.mode,
      memoryPosition: input.memoryPosition,
      clientMessageId: input.clientMessageId,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to update conversation history");
  }

  return (await response.json()) as TruncateSessionMemoryResult;
}

export async function loadChatMessages(sessionId: string): Promise<unknown> {
  const response = await apiFetch(
    `${API_BASE}/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error("Failed to load messages");
  return response.json();
}

export function ingestionStatusLabel(status: DocumentStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading file...";
    case "ocr_processing":
      return "Extracting text (OCR)...";
    case "embedding_processing":
      return "Creating embeddings...";
    case "ready":
      return "Document ready";
    case "failed":
      return "Processing failed";
    default:
      return "Processing...";
  }
}

// ─── Profiling (personalization) ─────────────────────────────────────────────

export type ProfileSectionKey =
  | "facts"
  | "preferences"
  | "interests"
  | "expertise"
  | "goals";

export type ProfileSections = Record<ProfileSectionKey, string[]>;

export type ExplicitFact = {
  section: ProfileSectionKey | null;
  fact: string;
  createdAt: string;
};

export type ProfileDto = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
  updatedAt: string;
};

export type ProfilingPayload = {
  user: ProfileDto | null;
  projects: Array<{ id: string; name: string; profile: ProfileDto | null }>;
};

export async function getProfiling(): Promise<ProfilingPayload> {
  const response = await apiFetch(`${API_BASE}/api/profiling`);
  if (!response.ok) throw new Error("Failed to load profiles");
  return (await response.json()) as ProfilingPayload;
}

export async function resetUserProfile(): Promise<{ ok: true }> {
  const response = await apiFetch(`${API_BASE}/api/profiling?scope=user`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("Failed to reset profile");
  return (await response.json()) as { ok: true };
}

export async function resetProjectProfile(
  projectId: string,
): Promise<{ ok: true }> {
  const response = await apiFetch(
    `${API_BASE}/api/profiling/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to reset project profile");
  return (await response.json()) as { ok: true };
}
