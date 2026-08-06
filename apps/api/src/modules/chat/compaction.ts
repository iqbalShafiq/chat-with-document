import { ExtractorBuilder } from "@anvia/core/extractor";
import type { CompletionModel, Message, Usage } from "@anvia/core";
import type { extractTextFromMessageJson } from "@assingment/agent";
import z from "zod";
import { prisma } from "../../utils/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "../../lib/token-estimate.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

export type MemoryGroup = {
  kind: "system" | "user" | "assistant" | "tool";
  messages: Message[];
};

/**
 * Sequential pass over memory messages:
 * - system messages each form their own group
 * - user starts a new group
 * - assistant with tool calls merges with the immediately following tool
 *   messages into one group; plain assistant text is its own group
 * - tool messages not preceded by a tool-call assistant belong to the
 *   previous group (a leading orphan tool starts a "tool" group)
 */
export function groupMemoryMessages(messages: Message[]): MemoryGroup[] {
  const groups: MemoryGroup[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      groups.push({ kind: "system", messages: [message] });
    } else if (message.role === "user") {
      groups.push({ kind: "user", messages: [message] });
    } else if (message.role === "assistant") {
      groups.push({ kind: "assistant", messages: [message] });
    } else {
      const previous = groups[groups.length - 1];
      if (previous) {
        previous.messages.push(message);
      } else {
        groups.push({ kind: "tool", messages: [message] });
      }
    }
  }
  return groups;
}

/**
 * Index into `groups` of the first kept group: keep the last `keepTurns`
 * user groups and everything after them. Returns 0 when fewer user turns
 * exist (nothing to summarize away).
 */
export function findCompactionBoundary(
  groups: MemoryGroup[],
  keepTurns: number,
): number {
  let userGroupsSeen = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]!.kind === "user") {
      userGroupsSeen += 1;
      if (userGroupsSeen >= keepTurns) {
        return i;
      }
    }
  }
  return 0;
}

/**
 * Drop groups from the start (skipping system groups) while the remaining
 * token estimate exceeds the target and more non-system groups remain.
 * System groups are never truncated.
 */
export function truncateGroupsToTarget(
  groups: MemoryGroup[],
  targetTokens: number,
): { kept: MemoryGroup[]; removed: MemoryGroup[] } {
  const removed: MemoryGroup[] = [];
  let kept = groups;
  for (;;) {
    const oldestNonSystem = kept.findIndex((group) => group.kind !== "system");
    if (oldestNonSystem === -1) break;
    if (
      estimateMessagesTokens(kept.flatMap((group) => group.messages)) <=
      targetTokens
    ) {
      break;
    }
    removed.push(kept[oldestNonSystem]!);
    kept = kept.filter((_, index) => index !== oldestNonSystem);
  }
  return { kept, removed };
}

export type CompactionResult =
  | { skipped: true; reason: "below-threshold" }
  | { skipped: true; reason: "summarize-failed"; error: string }
  | {
      skipped: false;
      stats: {
        beforeTokens: number;
        afterTokens: number;
        summarizedMessages: number;
        truncatedGroups: number;
        summaryTokens: number;
      };
    };

const COMPACTION_SUMMARY_INSTRUCTIONS = [
  "You are summarizing an earlier portion of a conversation so a long chat can continue.",
  "Produce a dense, factual summary that preserves: key facts and numbers, decisions made, user preferences and requirements, open questions, and outcomes of tool/document lookups.",
  "Keep the summary under the stated token budget. Use bullet points.",
  "Do not add anything that is not supported by the conversation.",
  "Output the summary as plain text.",
].join("\n");

const summarySchema = z.object({ summary: z.string() });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `[role] text` line; falls back to JSON when the message has no extractable text. */
function renderMessageForSummary(
  message: Message,
  extractText: typeof extractTextFromMessageJson,
): string {
  const content = message.content;
  const text = typeof content === "string" ? content : extractText(message);
  if (text.trim().length > 0) {
    return `[${message.role}] ${text}`;
  }
  try {
    return `[${message.role}] ${JSON.stringify(message)}`;
  } catch {
    return `[${message.role}]`;
  }
}

/**
 * @assingment/agent evaluates OpenAIClient construction at module load and
 * throws without OPENAI_API_KEY. Load it lazily so this module stays
 * importable in tests (env-less); the app always runs with env loaded.
 */
async function lunaModel(): Promise<CompletionModel> {
  const { createCompletionModel } = await import("@assingment/agent");
  return createCompletionModel("gpt-5.6-luna");
}

async function summarizeMessages(input: {
  model: CompletionModel;
  messages: Message[];
  budgetTokens: number;
}): Promise<{ summary: string; usage: Usage }> {
  const { extractTextFromMessageJson } = await import("@assingment/agent");
  const text = input.messages
    .map((message) => renderMessageForSummary(message, extractTextFromMessageJson))
    .filter(Boolean)
    .join("\n");
  const extractor = new ExtractorBuilder(input.model, summarySchema)
    .instructions(
      [
        ...COMPACTION_SUMMARY_INSTRUCTIONS,
        `Token budget: at most ${input.budgetTokens} tokens for the summary.`,
      ].join("\n"),
    )
    .retries(1)
    .build();
  const result = await extractor.extractWithUsage(text);
  return { summary: result.data.summary.trim(), usage: result.usage };
}

/**
 * Compacts a session's memory: summarizes the prefix with Luna and rewrites
 * the memory rows as [summary, ...kept suffix]. Truncation is only a
 * backstop after a successful summarize — a summarize failure aborts
 * compaction entirely (returns skipped). Throws only on DB errors.
 */
export async function compactSessionMemory(input: {
  sessionId: string;
  userId: string;
  windowTokens: number;
  keepTurns: number;
  triggerRatio: number;
  targetRatio: number;
  summaryBudgetRatio: number;
}): Promise<CompactionResult> {
  const scopeKey = createDefaultMemoryScopeKey(input.sessionId, input.userId);
  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (!session) return { skipped: true, reason: "below-threshold" };

  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: session.id },
    orderBy: { position: "asc" },
    select: { position: true, message: true, createdAt: true },
  });
  const messages = rows
    .map((row) => row.message as Message)
    .filter((message) => !(isRecord(message.metadata) && message.metadata.kind === "error"));

  const beforeTokens = estimateMessagesTokens(messages);
  const triggerTokens = Math.floor(input.windowTokens * input.triggerRatio);
  const targetTokens = Math.floor(input.windowTokens * input.targetRatio);
  if (beforeTokens <= triggerTokens) return { skipped: true, reason: "below-threshold" };

  const groups = groupMemoryMessages(messages);
  const boundary = findCompactionBoundary(groups, input.keepTurns);
  const prefix = groups.slice(0, boundary).flatMap((group) => group.messages);
  const suffix = groups.slice(boundary).flatMap((group) => group.messages);

  const summaryBudget = Math.floor(input.windowTokens * input.summaryBudgetRatio);
  let summaryText: string;
  try {
    const summarized = await summarizeMessages({
      model: await lunaModel(),
      messages: prefix,
      budgetTokens: summaryBudget,
    });
    summaryText = summarized.summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[compaction] summarize failed ${input.sessionId}: ${message}`);
    return { skipped: true, reason: "summarize-failed", error: message };
  }

  const summaryMessage: Message = {
    role: "system",
    content: summaryText,
    metadata: { kind: "summary" },
  } as Message;

  let keptSuffix = suffix;
  let truncatedGroups = 0;
  const afterSummaryTokens = estimateMessagesTokens([summaryMessage, ...suffix]);
  if (afterSummaryTokens > targetTokens) {
    const result = truncateGroupsToTarget(groups.slice(boundary), targetTokens);
    keptSuffix = result.kept.flatMap((group) => group.messages);
    truncatedGroups = result.removed.length;
    // Safety: if the summary alone still exceeds the target, summarize tighter once.
    if (estimateMessagesTokens([summaryMessage]) > targetTokens) {
      try {
        const tighter = await summarizeMessages({
          model: await lunaModel(),
          messages: prefix,
          budgetTokens: Math.max(64, Math.floor(targetTokens * 0.5)),
        });
        summaryText = tighter.summary;
      } catch {
        // Keep the first summary; the run proceeds (honest provider error later if any).
      }
    }
  }

  const finalSummary: Message = {
    role: "system",
    content: summaryText,
    metadata: { kind: "summary" },
  } as Message;
  const finalMessages = [finalSummary, ...keptSuffix];
  const afterTokens = estimateMessagesTokens(finalMessages);

  const runId = `compaction:${Date.now()}`;
  // Kept messages are the same object references that came from `rows`
  // (grouping only slices/flatMaps), so identity lookup works; a
  // JSON.stringify equality scan guards against any identity break.
  const createdAtByMessage = new WeakMap<object, Date>();
  rows.forEach((row) => createdAtByMessage.set(row.message as object, row.createdAt));
  const originalCreatedAtFor = (message: Message): Date => {
    const direct = createdAtByMessage.get(message as object);
    if (direct) return direct;
    const json = JSON.stringify(message);
    const row = rows.find((candidate) => JSON.stringify(candidate.message) === json);
    return row ? row.createdAt : new Date();
  };

  await prisma.$transaction(async (tx) => {
    await tx.agentMemoryMessage.deleteMany({
      where: { memorySessionId: session.id },
    });
    await tx.agentMemoryMessage.create({
      data: {
        memorySessionId: session.id,
        runId,
        turn: 0,
        position: 1,
        role: "system",
        message: finalSummary as unknown as Prisma.InputJsonValue,
        createdAt: new Date(),
      },
    });
    for (const [index, message] of keptSuffix.entries()) {
      await tx.agentMemoryMessage.create({
        data: {
          memorySessionId: session.id,
          runId,
          turn: 0,
          position: index + 2,
          role: message.role,
          message: message as unknown as Prisma.InputJsonValue,
          createdAt: originalCreatedAtFor(message),
        },
      });
    }
  });

  return {
    skipped: false,
    stats: {
      beforeTokens,
      afterTokens,
      summarizedMessages: prefix.length,
      truncatedGroups,
      summaryTokens: estimateTextTokens(summaryText),
    },
  };
}
