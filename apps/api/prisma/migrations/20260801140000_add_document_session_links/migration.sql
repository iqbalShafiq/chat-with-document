-- CreateTable
CREATE TABLE "DocumentSession" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentSession_userId_sessionId_createdAt_idx" ON "DocumentSession"("userId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentSession_sessionId_idx" ON "DocumentSession"("sessionId");

-- CreateIndex
CREATE INDEX "DocumentSession_documentId_idx" ON "DocumentSession"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSession_documentId_sessionId_key" ON "DocumentSession"("documentId", "sessionId");

-- CreateIndex
CREATE INDEX "Document_userId_status_createdAt_idx" ON "Document"("userId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "DocumentSession" ADD CONSTRAINT "DocumentSession_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing document is linked to its origin session
INSERT INTO "DocumentSession" ("id", "documentId", "sessionId", "userId", "createdAt")
SELECT
  md5(random()::text || clock_timestamp()::text || d."id")::text,
  d."id",
  d."sessionId",
  d."userId",
  d."createdAt"
FROM "Document" d
ON CONFLICT ("documentId", "sessionId") DO NOTHING;
