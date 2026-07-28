export const API_BASE = "http://localhost:3001";

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
