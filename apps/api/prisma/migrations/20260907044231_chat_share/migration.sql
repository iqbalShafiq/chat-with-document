-- CreateTable
CREATE TABLE "ChatShare" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ChatShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatShare_token_key" ON "ChatShare"("token");

-- CreateIndex
CREATE INDEX "ChatShare_sessionId_createdAt_idx" ON "ChatShare"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatShare_userId_createdAt_idx" ON "ChatShare"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChatShare" ADD CONSTRAINT "ChatShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
