import { prisma } from "../../utils/prisma.js";
import { estimateMemoryTokens } from "@anvia/core/memory";
import type { ToolDefinition } from "@anvia/core";
import { findActiveModel } from "../models/service.js";
import { resolveChatAgentRecipe } from "./build-run-input.js";
import { createSanitizedMemoryStore } from "./memory-sanitizer.js";
import {
  estimateNativeStaticContextTokens,
  resolveModelTokenBudget,
} from "./memory-policy.js";
import type { ChatAgentRecipe } from "./run-recipe.js";

/**
 * Static context cost shared by the usage endpoint and the chat-run worker:
 * instructions + context blocks + tools (same math both places must use).
 */
export function estimateStaticContextTokens(input: {
  baseInstructions?: string;
  instructions: readonly string[];
  contextBlocks: readonly { text: string }[];
  tools?: readonly unknown[];
}): number {
  return estimateNativeStaticContextTokens({
    baseInstructions: input.baseInstructions,
    instructions: input.instructions,
    contextTexts: input.contextBlocks.map((block) => block.text),
    toolDefinitions: (input.tools ?? []).filter(
      (tool): tool is ToolDefinition =>
        typeof tool === "object" &&
        tool !== null &&
        typeof (tool as { name?: unknown }).name === "string" &&
        typeof (tool as { description?: unknown }).description === "string" &&
        typeof (tool as { parameters?: unknown }).parameters === "object",
    ),
  });
}

/** Return the frozen recipe cost; never rediscover tools on a usage request. */
export function estimateRecipeStaticContextTokens(recipe: ChatAgentRecipe): number {
  if (
    recipe.staticContext.staticContextTokens !==
    recipe.memoryPolicy.staticContextTokens
  ) {
    throw new Error("native memory static context policy is inconsistent");
  }
  return recipe.memoryPolicy.staticContextTokens;
}

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
  if (!modelInfo) {
    throw new Error("model catalog entry is unavailable");
  }
  const modelBudget = resolveModelTokenBudget(modelInfo);
  const recipe = await resolveChatAgentRecipe({
    sessionId: input.sessionId,
    userId: input.userId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    traceId: `context-usage:${input.sessionId}:${input.model}`,
    consumeSingleUseContext: false,
  });

  const memoryMessages = await createSanitizedMemoryStore(prisma).load({
    scope: {
      sessionId: input.sessionId,
      userId: input.userId,
    },
  });

  const estimatedTokens =
    estimateMemoryTokens(memoryMessages) + estimateRecipeStaticContextTokens(recipe);

  const lastRun = await prisma.agentUsageEvent.findFirst({
    where: { userId: input.userId, sessionId: input.sessionId },
    orderBy: { createdAt: "desc" },
    select: { inputTokens: true },
  });

  const window = modelBudget.contextWindowTokens;
  return {
    modelId: input.model,
    modelLabel: modelInfo.label,
    contextWindowTokens: window,
    maxInputTokens: modelBudget.maxInputTokens,
    maxOutputTokens: modelBudget.maxOutputTokens,
    estimatedTokens,
    ratio: window > 0 ? Math.min(1, estimatedTokens / window) : 0,
    thresholdRatio: window > 0 ? recipe.memoryPolicy.triggerAfterTokens / window : 0,
    targetRatio: window > 0 ? recipe.memoryPolicy.retentionRecentTokens / window : 0,
    thresholdTokens: recipe.memoryPolicy.triggerAfterTokens,
    targetTokens: recipe.memoryPolicy.retentionRecentTokens,
    lastRunInputTokens: lastRun?.inputTokens ?? null,
    reasoningEffort: input.reasoningEffort,
    estimatedAt: new Date().toISOString(),
  };
}
