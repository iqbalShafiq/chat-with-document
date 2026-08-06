-- CreateTable
CREATE TABLE "model_provider" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_model" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "hint" TEXT,
    "description" TEXT,
    "iconSvg" TEXT NOT NULL DEFAULT '',
    "contextWindowTokens" INTEGER NOT NULL,
    "maxInputTokens" INTEGER,
    "maxOutputTokens" INTEGER,
    "inputPricePerMTokens" DECIMAL(10,4),
    "cachedInputPricePerMTokens" DECIMAL(10,4),
    "outputPricePerMTokens" DECIMAL(10,4),
    "cacheWriteMultiplier" DECIMAL(5,3),
    "longPromptThresholdTokens" INTEGER,
    "longPromptInputMultiplier" DECIMAL(5,3),
    "longPromptOutputMultiplier" DECIMAL(5,3),
    "supportsReasoning" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reasoning_effort" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reasoning_effort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_reasoning_effort" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "effortId" TEXT NOT NULL,

    CONSTRAINT "model_reasoning_effort_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_provider_slug_key" ON "model_provider"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "chat_model_modelId_key" ON "chat_model"("modelId");

-- CreateIndex
CREATE INDEX "chat_model_providerId_idx" ON "chat_model"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "reasoning_effort_key_key" ON "reasoning_effort"("key");

-- CreateIndex
CREATE UNIQUE INDEX "model_reasoning_effort_modelId_effortId_key" ON "model_reasoning_effort"("modelId", "effortId");

-- AddForeignKey
ALTER TABLE "chat_model" ADD CONSTRAINT "chat_model_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "model_provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_reasoning_effort" ADD CONSTRAINT "model_reasoning_effort_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "chat_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_reasoning_effort" ADD CONSTRAINT "model_reasoning_effort_effortId_fkey" FOREIGN KEY ("effortId") REFERENCES "reasoning_effort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
