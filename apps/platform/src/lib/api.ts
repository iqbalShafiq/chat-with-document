export const API_BASE = "http://localhost:3001";

export type SessionListItem = {
  sessionId: string;
  updatedAt: string;
  title: string;
};

export type SessionListPage = {
  items: SessionListItem[];
  nextCursor: string | null;
};

export async function listSessions(input?: {
  cursor?: string | null;
  limit?: number;
}): Promise<SessionListPage> {
  const params = new URLSearchParams();
  if (input?.cursor) params.set("cursor", input.cursor);
  if (input?.limit) params.set("limit", String(input.limit));
  const qs = params.toString();
  const response = await fetch(
    `${API_BASE}/api/chat/sessions${qs ? `?${qs}` : ""}`,
  );
  if (!response.ok) {
    throw new Error("Failed to load sessions");
  }

  const data: unknown = await response.json();

  // New shape: { items, nextCursor }
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

  // Legacy shape: string[] (old API) — keep UI usable if server not restarted
  if (Array.isArray(data)) {
    const now = new Date().toISOString();
    const items: SessionListItem[] = data
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((sessionId) => ({
        sessionId,
        updatedAt: now,
        title: sessionId.length > 16 ? `${sessionId.slice(0, 8)}…` : sessionId,
      }));
    return { items, nextCursor: null };
  }

  throw new Error("Unexpected sessions response shape");
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
}

export interface UploadDocumentResponse {
  id: string;
  filename: string;
  status: DocumentStatus;
}

const READY_STATUSES = new Set<DocumentStatus>(["ready"]);
const FAILED_STATUSES = new Set<DocumentStatus>(["failed"]);

export function isDocumentReady(status: DocumentStatus) {
  return READY_STATUSES.has(status);
}

export function isDocumentFailed(status: DocumentStatus) {
  return FAILED_STATUSES.has(status);
}

export async function uploadDocument(input: {
  sessionId: string;
  file: File;
}) {
  const form = new FormData();
  form.append("sessionId", input.sessionId);
  form.append("file", input.file);

  const response = await fetch(`${API_BASE}/api/documents`, {
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
  const response = await fetch(
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
}

export async function getDocumentStatus(input: {
  sessionId: string;
  documentId: string;
}) {
  const response = await fetch(
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
