import type { Prisma } from "./generated/prisma/client.js";
import type { Job } from "bullmq";
import { Worker } from "bullmq";
import {
  buildDocumentSummary,
  chunkText,
  deleteDocumentChunks,
  embeddingModel,
  firstLinesSummary,
  parseCsv,
  parseXlsx,
  runDocumentOcr,
  sheetFromRows,
  upsertDocumentChunks,
  type DocumentChunkMetadata,
  type DocumentPageImage,
  type TabularSheet,
} from "@assingment/agent";
import type { EmbeddedDocument } from "@anvia/core/embeddings";
import { buildPageImageR2Key, getObjectBuffer, putObject } from "./lib/r2.js";
import {
  DOCUMENT_INGEST_QUEUE,
  type DocumentIngestJobData,
} from "./lib/queue.js";
import { getBullmqConnectionOptions } from "./lib/redis.js";
import {
  MAX_TABULAR_COLUMNS,
  MAX_TABULAR_ROWS,
} from "./modules/documents/service.js";
import {
  enqueueProfileRefresh,
  takeNeedsProfileRefresh,
} from "./modules/profiling/queue.js";
import { profileConfig } from "./modules/profiling/service.js";
import {
  createProfileWorker,
  scopeFromJobData,
} from "./modules/profiling/worker.js";
import { prisma } from "./utils/prisma.js";
import {
  CHAT_RUN_QUEUE,
  failChatRun,
  processChatRunJob,
  type ChatRunJobData,
} from "./modules/chat/run-worker.js";

console.log("[worker] boot");

const TABULAR_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

async function processDocumentIngest(job: Job<DocumentIngestJobData>) {
  const { documentId, userId, sessionId, r2Key, filename } = job.data;

  console.log(`[worker] ingest start ${documentId} (${filename})`);

  await prisma.document.update({
    where: { id: documentId },
    data: { status: "ocr_processing", errorMessage: null },
  });

  const fileBuffer = await getObjectBuffer(r2Key);
  const mime = (await prisma.document.findUnique({ where: { id: documentId }, select: { mimeType: true } }))?.mimeType ?? "";
  if (TABULAR_MIME_TYPES.has(mime)) {
    await processTabularIngest({ documentId, userId, sessionId, filename, mime, fileBuffer });
    return;
  }
  const ocr = await runDocumentOcr({ filename, data: fileBuffer });

  const pageImages = new Map<number, DocumentPageImage[]>();

  for (const page of ocr.pages) {
    const stored: DocumentPageImage[] = [];
    await Promise.all(
      page.images.map(async (image) => {
        try {
          const r2Key = buildPageImageR2Key({
            userId,
            sessionId,
            documentId,
            pageIndex: page.index,
            imageId: image.id,
            mediaType: image.mediaType,
          });
          await putObject(r2Key, Buffer.from(image.base64, "base64"), image.mediaType);
          stored.push({
            id: image.id,
            r2Key,
            mediaType: image.mediaType,
            topLeftX: image.topLeftX,
            topLeftY: image.topLeftY,
            bottomRightX: image.bottomRightX,
            bottomRightY: image.bottomRightY,
            ...(image.annotation === undefined ? {} : { annotation: image.annotation }),
          });
        } catch (error) {
          console.error(
            `[worker] page image upload failed ${documentId} page ${page.index} image ${image.id}`,
            error,
          );
        }
      }),
    );
    pageImages.set(page.index, stored);
  }

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
          images: (pageImages.get(page.index) ??
            []) as unknown as Prisma.InputJsonValue,
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
          userId,
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

async function processTabularIngest(input: {
  documentId: string;
  userId: string;
  sessionId: string;
  filename: string;
  mime: string;
  fileBuffer: Uint8Array;
}) {
  const { documentId, userId, sessionId, filename, mime, fileBuffer } = input;
  const sheets: TabularSheet[] =
    mime === "text/csv"
      ? [sheetFromRows(filename.replace(/\.csv$/i, ""), parseCsv(Buffer.from(fileBuffer).toString("utf8")))]
      : await parseXlsx(fileBuffer, filename);
  const flattened = sheets.flatMap((s) => s.rows);
  const maxColumns = Math.max(...sheets.map((s) => s.columns.length), 0);
  if (flattened.length === 0) throw new Error("File contains no data rows");
  if (flattened.length > MAX_TABULAR_ROWS) throw new Error(`Too many rows (max ${MAX_TABULAR_ROWS})`);
  if (maxColumns > MAX_TABULAR_COLUMNS) throw new Error(`Too many columns (max ${MAX_TABULAR_COLUMNS})`);

  const first = sheets[0]!;
  const markdown = toMarkdownTable(first);

  await prisma.$transaction(async (tx) => {
    await tx.documentPage.deleteMany({ where: { documentId } });
    await tx.documentPage.create({
      data: {
        documentId,
        pageIndex: 0,
        summary: firstLinesSummary(markdown),
        rawMarkdown: markdown,
      },
    });
    await tx.document.update({
      where: { id: documentId },
      data: {
        pageCount: 1,
        summary: buildDocumentSummary([firstLinesSummary(markdown)]),
        firstPageSummary: firstLinesSummary(markdown),
        tabularData: { sheets } as Prisma.InputJsonValue,
        status: "embedding_processing",
      },
    });
  });

  await deleteDocumentChunks(documentId);
  const chunks = chunkText(markdown);
  if (chunks.length > 0) {
    const vectors = await embeddingModel.embedTexts(chunks.map((c) => c.text));
    await upsertDocumentChunks(
      chunks.map((chunk, i) => ({
        id: `${documentId}:page0:${chunk.chunkIndex}`,
        document: chunk.text,
        embeddings: [{ document: chunk.text, vector: vectors[i]!.vector }],
        metadata: {
          userId, sessionId, documentId, filename,
          pageId: documentId,
          pageIndex: 0,
          chunkIndex: chunk.chunkIndex,
          chunkText: chunk.text,
          documentPageCount: 1,
        },
      })),
    );
  }

  await prisma.document.update({
    where: { id: documentId },
    data: { status: "ready", errorMessage: null },
  });
  console.log(`[worker] tabular ingest ready ${documentId}`);
}

function toMarkdownTable(sheet: TabularSheet): string {
  const header = `| ${sheet.columns.map((c) => c.name).join(" | ")} |`;
  const sep = `| ${sheet.columns.map(() => "---").join(" | ")} |`;
  const body = sheet.rows
    .slice(0, 200)
    .map((row) => `| ${sheet.columns.map((_, i) => String(row[i] ?? "")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
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
    connection: getBullmqConnectionOptions(),
    // OCR + embedding can take minutes; keep lock/stall intervals generous so
    // tsx-watch restarts don't mark in-flight jobs as stalled prematurely.
    lockDuration: 300_000,
    stalledInterval: 120_000,
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

if (profileConfig().enabled) {
  const profileWorker = createProfileWorker();

  profileWorker.on("ready", () => {
    console.log(`[profile] ready on queue profile-summary`);
  });

  profileWorker.on("completed", async (job) => {
    console.log(`[profile] completed ${job.id}`);
    const scope = scopeFromJobData(job.data);
    if (await takeNeedsProfileRefresh(scope)) {
      await enqueueProfileRefresh(scope);
      console.log(`[profile] follow-up scheduled ${job.id}`);
    }
  });

  profileWorker.on("failed", async (job, error) => {
    console.error(`[profile] failed ${job?.id}`, error);
    if (job?.data) {
      const scope = scopeFromJobData(job.data);
      if (await takeNeedsProfileRefresh(scope)) {
        await enqueueProfileRefresh(scope);
      }
    }
  });

  profileWorker.on("error", (error) => {
    console.error("[profile] worker error", error);
  });
}

console.log(`[worker] listening on queue ${DOCUMENT_INGEST_QUEUE}`);

const chatRunWorker = new Worker<ChatRunJobData>(
  CHAT_RUN_QUEUE,
  async (job) => {
    try {
      await processChatRunJob(job);
    } catch (error) {
      // failChatRun already ran inside the processor; keep BullMQ bookkeeping.
      throw error;
    }
  },
  {
    connection: getBullmqConnectionOptions(),
    concurrency: 2,
    lockDuration: 300_000,
    stalledInterval: 120_000,
  },
);

chatRunWorker.on("ready", () =>
  console.log(`[chat-run] ready on queue ${CHAT_RUN_QUEUE}`),
);

chatRunWorker.on("failed", async (job, error) => {
  if (job?.data) {
    await failChatRun(job.data.streamId, error, {
      sessionId: job.data.sessionId,
      userId: job.data.userId,
      promptMessage: job.data.promptMessage,
    });
  }
});

chatRunWorker.on("error", (error) =>
  console.error("[chat-run] worker error", error),
);
