import type { VectorMetadata } from "@anvia/core/embeddings";

export const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION ?? "document_page_chunks";

export const EMBEDDING_DIMENSIONS = 1024;

export interface DocumentChunkMetadata extends VectorMetadata {
  sessionId: string;
  documentId: string;
  filename: string;
  pageId: string;
  pageIndex: number;
  chunkIndex: number;
  chunkText: string;
  documentPageCount: number;
}
