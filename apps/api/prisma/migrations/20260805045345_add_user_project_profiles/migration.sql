-- CreateTable
CREATE TABLE "user_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '{}',
    "explicitFacts" JSONB NOT NULL DEFAULT '[]',
    "lastProcessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '{}',
    "explicitFacts" JSONB NOT NULL DEFAULT '[]',
    "lastProcessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profile_userId_key" ON "user_profile"("userId");

-- CreateIndex
CREATE INDEX "project_profile_userId_idx" ON "project_profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_profile_userId_projectId_key" ON "project_profile"("userId", "projectId");

-- AddForeignKey
ALTER TABLE "project_profile" ADD CONSTRAINT "project_profile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
