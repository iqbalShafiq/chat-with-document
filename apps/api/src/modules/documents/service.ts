import { prisma } from "../../utils/prisma.js";
import { buildDocumentR2Key, putObject } from "../../lib/r2.js";
import { getDocumentIngestQueue } from "../../lib/queue.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Per-user total document storage cap (all sessions). */
export const MAX_USER_STORAGE_BYTES = 200 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export class DocumentStorageQuotaError extends Error {
  readonly code = "STORAGE_QUOTA_EXCEEDED";
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly fileBytes: number;

  constructor(input: {
    usedBytes: number;
    maxBytes: number;
    fileBytes: number;
  }) {
    super(
      `Storage limit exceeded (${formatBytes(input.usedBytes + input.fileBytes)} / ${formatBytes(input.maxBytes)}). Delete documents or free space before uploading.`,
    );
    this.name = "DocumentStorageQuotaError";
    this.usedBytes = input.usedBytes;
    this.maxBytes = input.maxBytes;
    this.fileBytes = input.fileBytes;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function getUserStorageUsage(userId: string): Promise<{
  usedBytes: number;
  maxBytes: number;
  remainingBytes: number;
}> {
  const aggregate = await prisma.document.aggregate({
    where: { userId },
    _sum: { sizeBytes: true },
  });
  const usedBytes = aggregate._sum.sizeBytes ?? 0;
  return {
    usedBytes,
    maxBytes: MAX_USER_STORAGE_BYTES,
    remainingBytes: Math.max(0, MAX_USER_STORAGE_BYTES - usedBytes),
  };
}

export async function createDocumentUpload(input: {
  userId: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  data: Uint8Array;
}) {
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new Error("Unsupported file type");
  }
  if (input.data.byteLength > MAX_FILE_BYTES) {
    throw new Error("File exceeds 10MB limit");
  }
  if (input.data.byteLength === 0) {
    throw new Error("File is empty");
  }

  const storage = await getUserStorageUsage(input.userId);
  if (storage.usedBytes + input.data.byteLength > storage.maxBytes) {
    throw new DocumentStorageQuotaError({
      usedBytes: storage.usedBytes,
      maxBytes: storage.maxBytes,
      fileBytes: input.data.byteLength,
    });
  }

  const document = await prisma.document.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
      r2Key: "",
      status: "uploading",
    },
  });

  const r2Key = buildDocumentR2Key(
    input.userId,
    input.sessionId,
    document.id,
    input.filename,
  );

  await putObject(r2Key, input.data, input.mimeType);

  await prisma.document.update({
    where: { id: document.id },
    data: { r2Key, status: "queued" },
  });

  await getDocumentIngestQueue().add(
    "ingest",
    {
      documentId: document.id,
      userId: input.userId,
      sessionId: input.sessionId,
      r2Key,
      filename: input.filename,
      mimeType: input.mimeType,
    },
    { jobId: document.id },
  );

  return {
    id: document.id,
    filename: document.filename,
    status: "queued" as const,
    sizeBytes: document.sizeBytes,
  };
}

export async function getDocumentStatus(input: {
  userId: string;
  sessionId: string;
  documentId: string;
}) {
  const document = await prisma.document.findFirst({
    where: {
      id: input.documentId,
      userId: input.userId,
      sessionId: input.sessionId,
    },
    select: {
      id: true,
      filename: true,
      status: true,
      pageCount: true,
      errorMessage: true,
      firstPageSummary: true,
      sizeBytes: true,
    },
  });

  return document;
}

export async function listSessionDocuments(sessionId: string, userId: string) {
  return prisma.document.findMany({
    where: { sessionId, userId, status: "ready" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      filename: true,
      firstPageSummary: true,
      sizeBytes: true,
    },
  });
}
