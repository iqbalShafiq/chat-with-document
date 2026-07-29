import { Queue } from "bullmq";
import { getBullmqConnectionOptions } from "./redis.js";

export const DOCUMENT_INGEST_QUEUE = "document-ingest";

export interface DocumentIngestJobData {
  documentId: string;
  sessionId: string;
  r2Key: string;
  filename: string;
  mimeType: string;
}

let queue: Queue<DocumentIngestJobData> | null = null;

export function getDocumentIngestQueue() {
  if (!queue) {
    queue = new Queue<DocumentIngestJobData>(DOCUMENT_INGEST_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}
