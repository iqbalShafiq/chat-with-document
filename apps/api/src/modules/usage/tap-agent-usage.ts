import type { Usage } from "@anvia/core/completion";
import { recordAgentUsageEvent } from "./record-usage.js";

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};

function toUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as UsageLike;
  if (typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") {
    return null;
  }
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens:
      typeof u.totalTokens === "number"
        ? u.totalTokens
        : u.inputTokens + u.outputTokens,
    cachedInputTokens:
      typeof u.cachedInputTokens === "number" ? u.cachedInputTokens : 0,
    cacheCreationInputTokens:
      typeof u.cacheCreationInputTokens === "number"
        ? u.cacheCreationInputTokens
        : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type TapAgentUsageContext = {
  userId: string;
  sessionId: string;
  provider: string;
  model: string;
  agentId?: string;
};

/**
 * Tap agent stream events; on final/error with usage, persist AgentUsageEvent.
 * Never throws to the stream consumer — audit failures are logged only.
 */
export async function* tapAgentStreamUsage<T>(
  source: AsyncIterable<T>,
  ctx: TapAgentUsageContext,
): AsyncGenerator<T> {
  let recorded = false;

  const tryRecord = async (
    status: "completed" | "error",
    event: Record<string, unknown>,
  ) => {
    if (recorded) return;
    const usage = toUsage(event.usage);
    if (!usage) return;
    recorded = true;

    const runId =
      typeof event.runId === "string" && event.runId.length > 0
        ? event.runId
        : null;
    const errorMessage =
      status === "error" && event.error != null
        ? event.error instanceof Error
          ? event.error.message
          : String(event.error)
        : null;

    try {
      await recordAgentUsageEvent({
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        runId,
        provider: ctx.provider,
        model: ctx.model,
        agentId: ctx.agentId,
        usage,
        status,
        errorMessage,
        // final/error events rarely include rawResponse; cost stays null on OpenAI.
        rawResponse: event.response ?? event,
      });
    } catch (error) {
      console.error("[usage] failed to record AgentUsageEvent", error);
    }
  };

  for await (const item of source) {
    yield item;
    if (!isRecord(item)) continue;
    if (item.type === "final") {
      await tryRecord("completed", item);
    } else if (item.type === "error") {
      await tryRecord("error", item);
    }
  }
}
