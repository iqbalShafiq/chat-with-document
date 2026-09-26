-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "reportSource" JSONB;

-- AlterTable
ALTER TABLE "workspace_schedule" ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT;
