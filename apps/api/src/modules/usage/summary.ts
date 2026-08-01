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
  /** Aggregate by model id used for chat requests. */
  byModel: Array<{
    model: string;
    requestCount: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  /** Aggregate by reasoning effort (low / medium / high); legacy nulls omitted. */
  byReasoningEffort: Array<{
    reasoningEffort: string;
    requestCount: number;
    totalTokens: number;
  }>;
};

export async function getUserUsageSummary(
  userId: string,
): Promise<UserUsageSummary> {
  const [storage, tokenAgg, byModelGroups, byEffortGroups] = await Promise.all([
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
    prisma.agentUsageEvent.groupBy({
      by: ["model"],
      where: { userId },
      _count: { _all: true },
      _sum: {
        totalTokens: true,
        inputTokens: true,
        outputTokens: true,
      },
      orderBy: { _count: { model: "desc" } },
    }),
    prisma.agentUsageEvent.groupBy({
      by: ["reasoningEffort"],
      where: { userId, reasoningEffort: { not: null } },
      _count: { _all: true },
      _sum: { totalTokens: true },
      orderBy: { _count: { reasoningEffort: "desc" } },
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
    byModel: byModelGroups.map((row) => ({
      model: row.model,
      requestCount: row._count._all,
      totalTokens: row._sum.totalTokens ?? 0,
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
    })),
    byReasoningEffort: byEffortGroups
      .filter(
        (row): row is typeof row & { reasoningEffort: string } =>
          typeof row.reasoningEffort === "string" &&
          row.reasoningEffort.length > 0,
      )
      .map((row) => ({
        reasoningEffort: row.reasoningEffort,
        requestCount: row._count._all,
        totalTokens: row._sum.totalTokens ?? 0,
      })),
  };
}
