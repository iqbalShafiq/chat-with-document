-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "Project_userId_lastOpenedAt_idx" ON "Project"("userId", "lastOpenedAt");

-- CreateIndex
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Project_userId_name_idx" ON "Project"("userId", "name");

-- CreateIndex
CREATE INDEX "ChatSession_userId_projectId_updatedAt_idx" ON "ChatSession"("userId", "projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatSession_userId_updatedAt_idx" ON "ChatSession"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Document_userId_projectId_createdAt_idx" ON "Document"("userId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Document_userId_projectId_status_createdAt_idx" ON "Document"("userId", "projectId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill ChatSession from existing agent memory sessions (standalone; projectId NULL).
-- One row per distinct (userId, sessionId) with a non-null userId.
INSERT INTO "ChatSession" ("id", "userId", "projectId", "title", "createdAt", "updatedAt")
SELECT DISTINCT ON (m."userId", m."sessionId")
  m."sessionId",
  m."userId",
  NULL,
  NULL,
  m."createdAt",
  m."updatedAt"
FROM "AgentMemorySession" m
WHERE m."userId" IS NOT NULL
ORDER BY m."userId", m."sessionId", m."updatedAt" DESC
ON CONFLICT ("id") DO NOTHING;
