ALTER TABLE "Document" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE "Document" ADD COLUMN "parentDocumentId" TEXT;
ALTER TABLE "Document" ADD COLUMN "originUrl" TEXT;
ALTER TABLE "Document" ADD COLUMN "sourceNote" TEXT;
CREATE INDEX "Document_userId_origin_createdAt_idx" ON "Document"("userId", "origin", "createdAt");
