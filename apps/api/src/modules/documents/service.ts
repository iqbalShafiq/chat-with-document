import { prisma } from "../../utils/prisma.js";
import { buildDocumentR2Key, putObject } from "../../lib/r2.js";
import { getDocumentIngestQueue } from "../../lib/queue.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export async function createDocumentUpload(input: {
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

  const document = await prisma.document.create({
    data: {
      sessionId: input.sessionId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
      r2Key: "",
      status: "uploading",
    },
  });

  const r2Key = buildDocumentR2Key(
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
  };
}

export async function getDocumentStatus(input: {
  sessionId: string;
  documentId: string;
}) {
  const document = await prisma.document.findFirst({
    where: { id: input.documentId, sessionId: input.sessionId },
    select: {
      id: true,
      filename: true,
      status: true,
      pageCount: true,
      errorMessage: true,
      firstPageSummary: true,
    },
  });

  return document;
}

export async function listSessionDocuments(sessionId: string) {
  return prisma.document.findMany({
    where: { sessionId, status: "ready" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      filename: true,
      firstPageSummary: true,
    },
  });
}
