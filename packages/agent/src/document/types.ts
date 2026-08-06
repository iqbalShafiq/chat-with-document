import type { VectorMetadata } from "@anvia/core/embeddings";

export const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION ?? "document_page_chunks";

export const EMBEDDING_DIMENSIONS = 1024;

export interface DocumentChunkMetadata extends VectorMetadata {
  userId: string;
  sessionId: string;
  documentId: string;
  filename: string;
  pageId: string;
  pageIndex: number;
  chunkIndex: number;
  chunkText: string;
  documentPageCount: number;
}

export interface DocumentPageImage {
  id: string;
  r2Key: string;
  mediaType: string;
  topLeftX: number | null;
  topLeftY: number | null;
  bottomRightX: number | null;
  bottomRightY: number | null;
  annotation?: string | null;
}

export function normalizePageImages(value: unknown): DocumentPageImage[] {
  if (!Array.isArray(value)) return [];
  const images: DocumentPageImage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const r2Key = typeof record.r2Key === "string" ? record.r2Key : null;
    const mediaType = typeof record.mediaType === "string" ? record.mediaType : null;
    if (id === null || r2Key === null || mediaType === null) continue;
    const numberOrNull = (raw: unknown): number | null =>
      typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const annotation =
      typeof record.annotation === "string" ? record.annotation : null;
    images.push({
      id,
      r2Key,
      mediaType,
      topLeftX: numberOrNull(record.topLeftX),
      topLeftY: numberOrNull(record.topLeftY),
      bottomRightX: numberOrNull(record.bottomRightX),
      bottomRightY: numberOrNull(record.bottomRightY),
      ...(annotation === null ? {} : { annotation }),
    });
  }
  return images;
}
