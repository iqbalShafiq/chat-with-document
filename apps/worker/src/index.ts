import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { handleDocumentIngestJob } from "./processors/document-ingest.js";
import {
  DOCUMENT_INGEST_QUEUE,
  type DocumentIngestJobData,
} from "./processors/types.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:16379";

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker<DocumentIngestJobData>(
  DOCUMENT_INGEST_QUEUE,
  async (job) => {
    await handleDocumentIngestJob(job);
  },
  { connection },
);

worker.on("completed", (job) => {
  console.log(`[worker] completed document ingest ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] failed document ingest ${job?.id}`, error);
});

console.log(`[worker] listening on queue ${DOCUMENT_INGEST_QUEUE}`);
