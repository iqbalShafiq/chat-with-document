-- CreateTable
CREATE TABLE "user_skill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "issuesJson" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mcp_server" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "credentialsRef" TEXT NOT NULL DEFAULT '',
    "allowedToolsJson" JSONB NOT NULL DEFAULT '[]',
    "toolsJson" JSONB NOT NULL DEFAULT '[]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_mcp_server_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_skill_userId_updatedAt_idx" ON "user_skill"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_skill_userId_name_key" ON "user_skill"("userId", "name");

-- CreateIndex
CREATE INDEX "user_mcp_server_userId_updatedAt_idx" ON "user_mcp_server"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_mcp_server_userId_name_key" ON "user_mcp_server"("userId", "name");
