/** MIME types accepted by the documents API. */
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

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
