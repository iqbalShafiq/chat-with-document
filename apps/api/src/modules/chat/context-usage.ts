import { prisma } from "../../utils/prisma.js";
import { estimateMessagesTokens, estimateTextTokens } from "../../lib/token-estimate.js";
import { findActiveModel } from "../models/service.js";
import { buildChatRunInput } from "./build-run-input.js";

function envRatio(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

export const compactionConfig = {
  triggerRatio: envRatio("COMPACTION_TRIGGER_RATIO", 0.7),
  targetRatio: envRatio("COMPACTION_TARGET_RATIO", 0.3),
  keepTurns: Number(process.env.COMPACTION_KEEP_TURNS ?? 8) || 8,
  summaryBudgetRatio: envRatio("COMPACTION_SUMMARY_BUDGET_RATIO", 0.08),
};

export type ContextUsageInfo = {
  modelId: string;
  modelLabel: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  estimatedTokens: number;
  ratio: number;
  thresholdRatio: number;
  targetRatio: number;
  thresholdTokens: number;
  targetTokens: number;
  lastRunInputTokens: number | null;
  reasoningEffort: string | null;
  estimatedAt: string;
};

export async function computeContextUsage(input: {
  sessionId: string;
  userId: string;
  model: string;
  reasoningEffort: string | null;
}): Promise<ContextUsageInfo> {
  const modelInfo = await findActiveModel(input.model);
  const runInput = await buildChatRunInput({
    sessionId: input.sessionId,
    userId: input.userId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  });

  const memoryMessages = await runInput.memory.load({
    sessionId: input.sessionId,
    userId: input.userId,
  });

  let instructionsTokens = 0;
  for (const instruction of runInput.instructions) {
    instructionsTokens += estimateTextTokens(instruction);
  }
  let contextTokens = 0;
  for (const block of runInput.contextBlocks) {
    contextTokens += estimateTextTokens(block.text);
  }
  let toolsTokens = 0;
  for (const tool of runInput.tools) {
    try {
      toolsTokens += estimateTextTokens(JSON.stringify(tool));
    } catch {
      toolsTokens += 0;
    }
  }

  const estimatedTokens =
    estimateMessagesTokens(memoryMessages) + instructionsTokens + contextTokens + toolsTokens;

  const lastRun = await prisma.agentUsageEvent.findFirst({
    where: { userId: input.userId, sessionId: input.sessionId },
    orderBy: { createdAt: "desc" },
    select: { inputTokens: true },
  });

  const window = modelInfo?.contextWindowTokens ?? 1_050_000;
  return {
    modelId: input.model,
    modelLabel: modelInfo?.label ?? input.model,
    contextWindowTokens: window,
    maxInputTokens: modelInfo?.maxInputTokens ?? null,
    maxOutputTokens: modelInfo?.maxOutputTokens ?? null,
    estimatedTokens,
    ratio: window > 0 ? Math.min(1, estimatedTokens / window) : 0,
    thresholdRatio: compactionConfig.triggerRatio,
    targetRatio: compactionConfig.targetRatio,
    thresholdTokens: Math.floor(window * compactionConfig.triggerRatio),
    targetTokens: Math.floor(window * compactionConfig.targetRatio),
    lastRunInputTokens: lastRun?.inputTokens ?? null,
    reasoningEffort: input.reasoningEffort,
    estimatedAt: new Date().toISOString(),
  };
}
