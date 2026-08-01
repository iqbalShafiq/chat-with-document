import { prisma } from "../../utils/prisma.js";
import { getUserStorageUsage } from "../documents/service.js";

export type UserUsageSummary = {
  storage: {
    usedBytes: number;
    maxBytes: number;
    remainingBytes: number;
  };
  tokens: {
    /** No hard cap yet — null max means unlimited in UI. */
    maxTokens: null;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    /** Parts for composition bar (uncached input + cache read + output). */
    composition: {
      inputUncached: number;
      cacheRead: number;
      output: number;
    };
  };
};

export async function getUserUsageSummary(
  userId: string,
): Promise<UserUsageSummary> {
  const [storage, tokenAgg] = await Promise.all([
    getUserStorageUsage(userId),
    prisma.agentUsageEvent.aggregate({
      where: { userId },
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        cachedInputTokens: true,
        cacheCreationInputTokens: true,
      },
    }),
  ]);

  const inputTokens = tokenAgg._sum.inputTokens ?? 0;
  const outputTokens = tokenAgg._sum.outputTokens ?? 0;
  const totalTokens = tokenAgg._sum.totalTokens ?? 0;
  const cachedInputTokens = tokenAgg._sum.cachedInputTokens ?? 0;
  const cacheCreationInputTokens =
    tokenAgg._sum.cacheCreationInputTokens ?? 0;

  const inputUncached = Math.max(0, inputTokens - cachedInputTokens);

  return {
    storage: {
      usedBytes: storage.usedBytes,
      maxBytes: storage.maxBytes,
      remainingBytes: storage.remainingBytes,
    },
    tokens: {
      maxTokens: null,
      requestCount: tokenAgg._count._all,
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      composition: {
        inputUncached,
        cacheRead: cachedInputTokens,
        output: outputTokens,
      },
    },
  };
}
