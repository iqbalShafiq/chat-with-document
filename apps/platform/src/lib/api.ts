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
  /** True when a completed run exists after the user last read this session. */
  unread: boolean;
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
      ).map((item) => ({
        ...item,
        unread: item.unread === true,
      })),
      nextCursor:
        typeof page.nextCursor === "string" || page.nextCursor === null
          ? page.nextCursor
          : null,
    };
  }

  throw new Error("Unexpected sessions response shape");
}

export type ActiveRunInfo = {
  sessionId: string;
  streamId: string;
  status: string;
  lastEventId: number;
};

export async function listActiveRuns(): Promise<ActiveRunInfo[]> {
  const response = await apiFetch(`${API_BASE}/api/chat/runs`);
  if (!response.ok) throw new Error("Failed to load active runs");
  const data: unknown = await response.json();
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as { runs?: unknown }).runs)
  ) {
    const runs = (data as { runs: unknown[] }).runs.filter(
      (run): run is ActiveRunInfo =>
        !!run &&
        typeof run === "object" &&
        typeof (run as ActiveRunInfo).sessionId === "string" &&
        typeof (run as ActiveRunInfo).streamId === "string",
    );
    return runs;
  }
  throw new Error("Unexpected active runs response shape");
}

export async function markSessionRead(sessionId: string): Promise<void> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/sessions/mark-read`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    },
  );
  if (!response.ok) throw new Error("Failed to mark session read");
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

export type DocumentPageImageInfo = {
  id: string;
  mediaType: string;
};

export type DocumentPreviewPage = {
  pageIndex: number;
  summary: string;
  rawMarkdown: string;
  images?: DocumentPageImageInfo[];
};

export function buildDocumentImageUrl(
  documentId: string,
  pageIndex: number,
  imageId: string,
): string {
  return `${API_BASE}/api/documents/${encodeURIComponent(documentId)}/pages/${pageIndex}/images/${encodeURIComponent(imageId)}`;
}

export function isDocumentImagePath(value: string): boolean {
  return (
    value.startsWith("/api/documents/") ||
    value.startsWith(`${API_BASE}/api/documents/`)
  );
}

/** Resolve a document-image src (relative or absolute) to a fetchable URL. */
export function resolveDocumentImageUrl(value: string): string {
  return value.startsWith("/api/documents/") ? `${API_BASE}${value}` : value;
}

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

// ─── Model registry ─────────────────────────────────────────────────────────

export type ModelInfo = {
  modelId: string;
  label: string;
  /** Full display name, e.g. "GPT 5.6 Luna" (server falls back to label). */
  name: string;
  hint: string | null;
  description: string | null;
  iconSvg: string;
  provider: { slug: string; name: string };
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  prices: {
    input: number | null;
    cachedInput: number | null;
    output: number | null;
    cacheWriteMultiplier: number | null;
    longPromptThresholdTokens: number | null;
    longPromptInputMultiplier: number | null;
    longPromptOutputMultiplier: number | null;
  };
  reasoningEfforts: string[];
  /** "text" | "image" — chat model or image generator. */
  outputType: "text" | "image";
  /** Image-gen capability descriptors (from OpenRouter discovery). */
  imageCapabilities: ImageModelCapabilities | null;
  /** Input modalities the model accepts, e.g. ["text","image","file"]. */
  inputModalities: string[];
  sortOrder: number;
};

export type ReasoningEffortInfo = {
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

export type ModelCatalog = {
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
};

let modelsCache: ModelCatalog | null = null;

export async function listModels(input?: {
  force?: boolean;
}): Promise<ModelCatalog> {
  if (modelsCache !== null && !input?.force) return modelsCache;

  const response = await apiFetch(`${API_BASE}/api/models`);
  if (!response.ok) throw new Error("Failed to load models");

  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as ModelCatalog).models)
  ) {
    throw new Error("Unexpected models response shape");
  }

  const catalog: ModelCatalog = {
    // Chat model picker shows text models only — image generators live in
    // the composer's image-gen settings (fetchImageModels).
    models: (data as ModelCatalog).models.filter(
      (model): model is ModelInfo =>
        !!model &&
        typeof model.modelId === "string" &&
        typeof model.label === "string" &&
        model.outputType !== "image",
    ),
    reasoningEfforts: Array.isArray(
      (data as ModelCatalog).reasoningEfforts,
    )
      ? (data as ModelCatalog).reasoningEfforts
      : [],
  };
  modelsCache = catalog;
  return catalog;
}

export type ContextUsageInfo = {
  modelId: string;
  modelLabel: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  estimatedTokens: number;
  ratio: number;
  thresholdRatio: number;
  targetRatio: number;
  thresholdTokens: number;
  targetTokens: number;
  lastRunInputTokens: number | null;
  reasoningEffort: string | null;
  estimatedAt: string;
};

export async function fetchContextUsage(input: {
  sessionId: string;
  model: string;
  reasoningEffort: string | null;
}): Promise<ContextUsageInfo> {
  const params = new URLSearchParams();
  params.set("sessionId", input.sessionId);
  params.set("model", input.model);
  if (input.reasoningEffort) {
    params.set("reasoningEffort", input.reasoningEffort);
  }

  const response = await apiFetch(
    `${API_BASE}/api/chat/context-usage?${params.toString()}`,
  );
  if (!response.ok) throw new Error("Failed to load context usage");

  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as ContextUsageInfo).modelId !== "string" ||
    typeof (data as ContextUsageInfo).estimatedTokens !== "number"
  ) {
    throw new Error("Unexpected context usage response shape");
  }
  return data as ContextUsageInfo;
}

export type RunStatusInfo = {
  streamId: string | null;
  /** "missing": stream hash expired while the active-run key still lingers — clients treat it as idle. */
  status: "idle" | "running" | "completed" | "error" | "missing";
  lastEventId: number | null;
};

export async function fetchRunStatus(sessionId: string): Promise<RunStatusInfo> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/run-status?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error("Failed to load run status");

  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as RunStatusInfo).status !== "string" ||
    ((data as RunStatusInfo).streamId !== null &&
      typeof (data as RunStatusInfo).streamId !== "string")
  ) {
    throw new Error("Unexpected run status response shape");
  }
  return data as RunStatusInfo;
}

export async function stopChatRun(streamId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/chat/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamId }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to stop chat run");
  }
}

export type WebCapabilities = {
  webSearchAvailable: boolean;
  imageGenerationAvailable: boolean;
  context7Available: boolean;
};

let capabilitiesPromise: Promise<WebCapabilities> | null = null;

export async function fetchChatCapabilities(): Promise<WebCapabilities> {
  if (capabilitiesPromise === null) {
    capabilitiesPromise = fetchChatCapabilitiesRemote();
    capabilitiesPromise.catch(() => {
      // Drop the cache on failure so a transient error retries next call.
      capabilitiesPromise = null;
    });
  }
  return capabilitiesPromise;
}

async function fetchChatCapabilitiesRemote(): Promise<WebCapabilities> {
  const response = await apiFetch(`${API_BASE}/api/chat/capabilities`);
  if (!response.ok) throw new Error("Failed to load chat capabilities");

  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as WebCapabilities).webSearchAvailable !== "boolean" ||
    typeof (data as WebCapabilities).imageGenerationAvailable !== "boolean" ||
    typeof (data as WebCapabilities).context7Available !== "boolean"
  ) {
    throw new Error("Unexpected capabilities response shape");
  }
  return data as WebCapabilities;
}

// ─── Approval decisions ──────────────────────────────────────────────────────

export type DecideApprovalInput = {
  approvalId: string;
  approved: boolean;
  reason?: string;
  /** "session" persists a tool grant for the rest of the run; "once" (default) approves only the current call. */
  grantScope?: "once" | "session";
  /** UI-edited tool args staged for the tool's next call (e.g. image params). */
  overrideArgs?: Record<string, unknown>;
};

export async function decideApproval(
  input: DecideApprovalInput,
): Promise<void> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/approvals/${encodeURIComponent(input.approvalId)}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approved: input.approved,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.grantScope !== undefined
          ? { grantScope: input.grantScope }
          : {}),
        ...(input.overrideArgs && Object.keys(input.overrideArgs).length > 0
          ? { overrideArgs: input.overrideArgs }
          : {}),
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to send approval decision");
  }
}

// ─── Image generation ────────────────────────────────────────────────────────

export type ImageGenSettings = {
  modelId?: string;
  aspectRatio?: string;
  quality?: string;
  background?: string;
  n?: number;
};

export type GeneratedImageMeta = {
  id: string;
  sessionId: string;
  projectId: string | null;
  mediaType: string;
  width: number;
  height: number;
  modelId: string;
  prompt: string;
  nOfTotal: string | null;
  createdAt: string;
};

export type ClarificationResponseBody = {
  answers: Record<string, string | string[]>;
  skipped: string[];
};

export type ImageModelCapabilities = {
  quality?: string[];
  background?: string[];
  n?: { min: number; max: number };
  aspectRatios?: string[];
  resolutions?: string[];
  /** Exact pixel sizes the model accepts (OpenAI-style); drives the size UI. */
  sizes?: string[];
};

export type ImageModelCatalogItem = {
  modelId: string;
  name: string;
  label: string;
  hint: string;
  iconSvg: string;
  imageCapabilities: ImageModelCapabilities | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length > 0 ? strings : undefined;
}

function parseImageModelCapabilities(value: unknown): ImageModelCapabilities | null {
  if (!isRecord(value)) return null;
  const n =
    isRecord(value.n) &&
    typeof value.n.min === "number" &&
    typeof value.n.max === "number"
      ? { min: value.n.min, max: value.n.max }
      : undefined;
  const quality = stringArray(value.quality);
  const background = stringArray(value.background);
  const aspectRatios = stringArray(value.aspectRatios);
  const resolutions = stringArray(value.resolutions);
  const sizes = stringArray(value.sizes);
  if (
    !n &&
    !quality &&
    !background &&
    !aspectRatios &&
    !resolutions &&
    !sizes
  ) {
    return null;
  }
  return {
    ...(n ? { n } : {}),
    ...(quality ? { quality } : {}),
    ...(background ? { background } : {}),
    ...(aspectRatios ? { aspectRatios } : {}),
    ...(resolutions ? { resolutions } : {}),
    ...(sizes ? { sizes } : {}),
  };
}

let imageModelsPromise: Promise<ImageModelCatalogItem[]> | null = null;

export async function fetchImageModels(): Promise<ImageModelCatalogItem[]> {
  if (imageModelsPromise === null) {
    imageModelsPromise = fetchImageModelsRemote();
    imageModelsPromise.catch(() => {
      // Drop the cache on failure so a transient error retries next call.
      imageModelsPromise = null;
    });
  }
  return imageModelsPromise;
}

async function fetchImageModelsRemote(): Promise<ImageModelCatalogItem[]> {
  const response = await apiFetch(
    `${API_BASE}/api/models?outputType=image`,
  );
  if (!response.ok) throw new Error("Failed to load image models");

  const data: unknown = await response.json();
  // The backend filters by outputType=image; the shape guard stays as cheap
  // defense against a misbehaving server.
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw new Error("Unexpected image models response shape");
  }

  return (data.models as unknown[])
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        typeof item.modelId === "string" &&
        typeof item.name === "string" &&
        typeof item.label === "string",
    )
    .map((item) => ({
      modelId: item.modelId as string,
      name: item.name as string,
      label: item.label as string,
      hint: typeof item.hint === "string" ? item.hint : "",
      iconSvg: typeof item.iconSvg === "string" ? item.iconSvg : "",
      imageCapabilities: parseImageModelCapabilities(item.imageCapabilities),
    }));
}

function isGeneratedImageMeta(value: unknown): value is GeneratedImageMeta {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    (value.projectId === null || typeof value.projectId === "string") &&
    typeof value.mediaType === "string" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.modelId === "string" &&
    typeof value.prompt === "string" &&
    (value.nOfTotal === null || typeof value.nOfTotal === "string") &&
    typeof value.createdAt === "string"
  );
}

function parseGeneratedImages(data: unknown): GeneratedImageMeta[] {
  if (!isRecord(data) || !Array.isArray(data.images)) {
    throw new Error("Unexpected images response shape");
  }
  return (data.images as unknown[]).filter(isGeneratedImageMeta);
}

export async function fetchSessionImages(
  sessionId: string,
): Promise<GeneratedImageMeta[]> {
  const response = await apiFetch(
    `${API_BASE}/api/images?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error("Failed to load session images");
  return parseGeneratedImages(await response.json());
}

export async function fetchProjectImages(
  projectId: string,
): Promise<GeneratedImageMeta[]> {
  const response = await apiFetch(
    `${API_BASE}/api/images?projectId=${encodeURIComponent(projectId)}`,
  );
  if (!response.ok) throw new Error("Failed to load project images");
  return parseGeneratedImages(await response.json());
}

export async function fetchUserImages(): Promise<GeneratedImageMeta[]> {
  const response = await apiFetch(`${API_BASE}/api/images?scope=user`);
  if (!response.ok) throw new Error("Failed to load user images");
  return parseGeneratedImages(await response.json());
}

export async function fetchImageBytes(
  id: string,
): Promise<{ blob: Blob; mediaType: string }> {
  const response = await apiFetch(
    `${API_BASE}/api/images/${encodeURIComponent(id)}`,
  );
  if (!response.ok) throw new Error("Failed to load image");
  return {
    blob: await response.blob(),
    mediaType: response.headers.get("content-type") ?? "image/png",
  };
}

/** Active image context — images pinned as chat context for a session. */
export async function fetchSessionImageContexts(
  sessionId: string,
): Promise<GeneratedImageMeta[]> {
  const response = await apiFetch(
    `${API_BASE}/api/images/context?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error("Failed to load image contexts");
  return parseGeneratedImages(await response.json());
}

export async function addSessionImageContext(input: {
  sessionId: string;
  imageId: string;
}): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/images/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to pin image as context");
  }
}

export async function removeSessionImageContext(input: {
  sessionId: string;
  imageId: string;
}): Promise<void> {
  const response = await apiFetch(
    `${API_BASE}/api/images/context/${encodeURIComponent(input.imageId)}?sessionId=${encodeURIComponent(input.sessionId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to unpin image context");
}

export async function submitClarification(input: {
  clarificationId: string;
  body: ClarificationResponseBody;
}): Promise<void> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/clarifications/${encodeURIComponent(input.clarificationId)}/response`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to send clarification response");
  }
}
