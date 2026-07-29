import type { Prisma } from "./generated/prisma/client.js";
import type { Job } from "bullmq";
import { Worker } from "bullmq";
import {
  buildDocumentSummary,
  chunkText,
  deleteDocumentChunks,
  embeddingModel,
  firstLinesSummary,
  runDocumentOcr,
  upsertDocumentChunks,
  type DocumentChunkMetadata,
} from "@assingment/agent";
import type { EmbeddedDocument } from "@anvia/core/embeddings";
import { getObjectBuffer } from "./lib/r2.js";
import {
  DOCUMENT_INGEST_QUEUE,
  type DocumentIngestJobData,
} from "./lib/queue.js";
import { getBullmqConnectionOptions } from "./lib/redis.js";
import { prisma } from "./utils/prisma.js";

console.log("[worker] boot");

async function processDocumentIngest(job: Job<DocumentIngestJobData>) {
  const { documentId, sessionId, r2Key, filename } = job.data;

  console.log(`[worker] ingest start ${documentId} (${filename})`);

  await prisma.document.update({
    where: { id: documentId },
    data: { status: "ocr_processing", errorMessage: null },
  });

  const fileBuffer = await getObjectBuffer(r2Key);
  const ocr = await runDocumentOcr({ filename, data: fileBuffer });

  const pageSummaries: string[] = [];

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.documentPage.deleteMany({ where: { documentId } });

    for (const page of ocr.pages) {
      const summary = firstLinesSummary(page.markdown);
      pageSummaries.push(summary);

      await tx.documentPage.create({
        data: {
          documentId,
          pageIndex: page.index,
          summary,
          rawMarkdown: page.markdown,
        },
      });
    }

    const firstPageSummary = pageSummaries[0] ?? "";
    const documentSummary = buildDocumentSummary(pageSummaries);

    await tx.document.update({
      where: { id: documentId },
      data: {
        pageCount: ocr.pageCount,
        summary: documentSummary,
        firstPageSummary,
        status: "embedding_processing",
      },
    });
  });

  await deleteDocumentChunks(documentId);

  const pages = await prisma.documentPage.findMany({
    where: { documentId },
    orderBy: { pageIndex: "asc" },
  });

  const embeddedDocuments: Array<
    EmbeddedDocument<string, DocumentChunkMetadata>
  > = [];

  for (const page of pages) {
    const chunks = chunkText(page.rawMarkdown);
    if (chunks.length === 0) continue;

    const vectors = await embeddingModel.embedTexts(
      chunks.map((chunk) => chunk.text),
    );

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      const vector = vectors[i]!;
      embeddedDocuments.push({
        id: `${page.id}:${chunk.chunkIndex}`,
        document: chunk.text,
        embeddings: [{ document: chunk.text, vector: vector.vector }],
        metadata: {
          sessionId,
          documentId,
          filename,
          pageId: page.id,
          pageIndex: page.pageIndex,
          chunkIndex: chunk.chunkIndex,
          chunkText: chunk.text,
          documentPageCount: ocr.pageCount,
        },
      });
    }
  }

  if (embeddedDocuments.length > 0) {
    await upsertDocumentChunks(embeddedDocuments);
  }

  await prisma.document.update({
    where: { id: documentId },
    data: { status: "ready", errorMessage: null },
  });

  console.log(`[worker] ingest ready ${documentId}`);
}

export const worker = new Worker<DocumentIngestJobData>(
  DOCUMENT_INGEST_QUEUE,
  async (job) => {
    try {
      await processDocumentIngest(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ingest failed";
      await prisma.document.update({
        where: { id: job.data.documentId },
        data: { status: "failed", errorMessage: message },
      });
      throw error;
    }
  },
  {
    // Pass options (not a shared ioredis instance) so BullMQ owns blocking conns.
    connection: getBullmqConnectionOptions(),
  },
);

worker.on("ready", () => {
  console.log(`[worker] ready on queue ${DOCUMENT_INGEST_QUEUE}`);
});

worker.on("completed", (job) => {
  console.log(`[worker] completed document ingest ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] failed document ingest ${job?.id}`, error);
});

worker.on("error", (error) => {
  console.error("[worker] error", error);
});

console.log(`[worker] listening on queue ${DOCUMENT_INGEST_QUEUE}`);
