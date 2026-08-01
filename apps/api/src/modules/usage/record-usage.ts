import type { Usage } from "@anvia/core/completion";
import { prisma } from "../../utils/prisma.js";
import { extractProviderCostUsd } from "./extract-provider-cost.js";

export type RecordAgentUsageInput = {
  userId: string;
  sessionId: string;
  runId?: string | null;
  agentId?: string;
  provider: string;
  model: string;
  usage: Usage;
  status: "completed" | "error";
  errorMessage?: string | null;
  /** Optional raw provider payload for cost extraction only. */
  rawResponse?: unknown;
};

export async function recordAgentUsageEvent(
  input: RecordAgentUsageInput,
): Promise<void> {
  const cost = extractProviderCostUsd(input.rawResponse);

  await prisma.agentUsageEvent.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      agentId: input.agentId ?? "my-agent",
      provider: input.provider,
      model: input.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      totalTokens: input.usage.totalTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
      totalCostUsd: cost?.totalCostUsd ?? null,
      currency: cost?.currency ?? null,
      costSource: cost?.source ?? null,
      providerUsageJson: {
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        totalTokens: input.usage.totalTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
      },
      status: input.status,
      errorMessage: input.errorMessage ?? null,
    },
  });
}
