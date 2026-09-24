-- AlterTable
ALTER TABLE "workspace_task" ADD COLUMN     "description" TEXT,
ADD COLUMN     "subtasks" JSONB NOT NULL DEFAULT '[]';
