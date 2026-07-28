-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('queued', 'uploading', 'ocr_processing', 'embedding_processing', 'ready', 'failed');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "r2Key" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "status" "DocumentStatus" NOT NULL DEFAULT 'queued',
    "errorMessage" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "firstPageSummary" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageIndex" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "rawMarkdown" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_sessionId_createdAt_idx" ON "Document"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "Document_sessionId_status_idx" ON "Document"("sessionId", "status");

-- CreateIndex
CREATE INDEX "DocumentPage_documentId_pageIndex_idx" ON "DocumentPage"("documentId", "pageIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPage_documentId_pageIndex_key" ON "DocumentPage"("documentId", "pageIndex");

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
