-- CreateTable
CREATE TABLE "session_image_context" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_image_context_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_image_context_userId_sessionId_idx" ON "session_image_context"("userId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "session_image_context_sessionId_imageId_key" ON "session_image_context"("sessionId", "imageId");

-- AddForeignKey
ALTER TABLE "session_image_context" ADD CONSTRAINT "session_image_context_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "generated_image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
