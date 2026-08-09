-- AlterTable
ALTER TABLE "chat_model" ADD COLUMN     "imageCapabilities" JSONB,
ADD COLUMN     "inputModalities" JSONB,
ADD COLUMN     "outputModalities" JSONB,
ADD COLUMN     "outputType" TEXT NOT NULL DEFAULT 'text';

-- CreateTable
CREATE TABLE "generated_image" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "sessionId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "modelId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "nOfTotal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "generated_image_r2Key_key" ON "generated_image"("r2Key");

-- CreateIndex
CREATE INDEX "generated_image_userId_projectId_idx" ON "generated_image"("userId", "projectId");

-- CreateIndex
CREATE INDEX "generated_image_sessionId_idx" ON "generated_image"("sessionId");
