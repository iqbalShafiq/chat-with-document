-- CreateTable
CREATE TABLE "session_context_snippet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_context_snippet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_context_snippet_sessionId_key" ON "session_context_snippet"("sessionId");

-- CreateIndex
CREATE INDEX "session_context_snippet_userId_idx" ON "session_context_snippet"("userId");
