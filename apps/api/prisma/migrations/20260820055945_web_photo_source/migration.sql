-- AlterTable
ALTER TABLE "generated_image" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'generated',
ADD COLUMN     "sourceUrl" TEXT;

-- CreateIndex
CREATE INDEX "generated_image_sessionId_source_idx" ON "generated_image"("sessionId", "source");
