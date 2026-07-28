export interface DocumentIngestJobData {
  documentId: string;
  sessionId: string;
  r2Key: string;
  filename: string;
  mimeType: string;
}

export const DOCUMENT_INGEST_QUEUE = "document-ingest";
