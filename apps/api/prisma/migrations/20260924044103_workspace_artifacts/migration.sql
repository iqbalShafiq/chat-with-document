-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "citationMap" JSONB,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'source';

-- AlterTable
ALTER TABLE "generated_image" ADD COLUMN     "caption" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "web_bundle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inbox',
    "sourceSessionId" TEXT,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_schedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "freq" TEXT NOT NULL DEFAULT 'once',
    "nextRunAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "web_bundle_userId_projectId_createdAt_idx" ON "web_bundle"("userId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_task_userId_projectId_status_idx" ON "workspace_task"("userId", "projectId", "status");

-- CreateIndex
CREATE INDEX "workspace_schedule_userId_status_nextRunAt_idx" ON "workspace_schedule"("userId", "status", "nextRunAt");
