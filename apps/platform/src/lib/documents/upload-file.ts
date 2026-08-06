/** MIME types accepted by the documents API. */
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Client-side mirror of the documents API cap
 * (apps/api/src/modules/documents/service.ts MAX_FILE_BYTES).
 * Kept in sync so oversized files are rejected at attach time, before they
 * ever reach the composer queue or the upload pipeline.
 */
export const MAX_DOCUMENT_FILE_BYTES = 10 * 1024 * 1024;

/** Rejected at attach time (client-side guardrail, not an ingest failure). */
export type AttachmentReject = {
  id: string;
  filename: string;
  message: string;
};

/** Returns a human message when the file must be rejected, else null. */
export function validateDocumentFile(file: File): string | null {
  if (file.size > MAX_DOCUMENT_FILE_BYTES) {
    return `${file.name} exceeds 10MB limit`;
  }
  return null;
}

/**
 * Windows / some browsers leave `File.type` empty for PDFs.
 * Infer from extension so the API does not reject as octet-stream.
 */
export function resolveUploadMimeType(file: File): string {
  if (file.type && file.type !== "application/octet-stream") {
    return file.type;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? (file.type || "application/octet-stream");
}

/** Return a File with a corrected MIME type when needed (same bytes/name). */
export function ensureUploadableFile(file: File): File {
  const mime = resolveUploadMimeType(file);
  if (mime === file.type) return file;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}
