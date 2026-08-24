import { parseMessage, type CompletionModel, type Message, type Usage } from "@anvia/core";
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

function hasStrictToolCall(message: Message): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(
    (part) => isRecord(part) && part.type === "tool-call",
  );
}

function strictToolCallIds(message: Message): Set<string> {
  const ids = new Set<string>();
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return ids;
  }
  for (const part of message.content) {
    if (
      isRecord(part) &&
      part.type === "tool-call" &&
      typeof part.toolCallId === "string"
    ) {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function strictToolResultIds(message: Message): string[] {
  if (message.role !== "tool" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) =>
    isRecord(part) &&
    part.type === "tool-result" &&
    typeof part.toolCallId === "string"
      ? [part.toolCallId]
      : [],
  );
}

/**
 * One compaction record. Segments are stored in
 * `AgentMemorySession.metadata.compaction` — memory rows are never deleted or
 * rewritten. `upToPosition` values are strictly increasing across the list:
 * each pass covers the uncovered range, and the truncate backstop extends it.
 */
export type CompactionSegment =
  | { kind: "summarized"; upToPosition: number; summary: string; createdAt: string }
  | { kind: "dropped"; upToPosition: number; createdAt: string };

/**
 * Sequential pass over memory messages:
 * - system messages each form their own group
 * - user starts a new group
 * - assistant with strict tool-call parts merges with immediately following
 *   matching tool-result messages into one atomic group; plain assistant text
 *   is its own group
 * - unmatched/orphan tool messages stay in a separate "tool" group
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
      const resultIds = strictToolResultIds(message);
      const assistantToolCallIds =
        previous?.kind === "assistant"
          ? previous.messages.flatMap((item) => [
              ...strictToolCallIds(item),
            ])
          : [];
      if (
        previous?.kind === "assistant" &&
        previous.messages.some(hasStrictToolCall) &&
        resultIds.length > 0 &&
        resultIds.every((id) => assistantToolCallIds.includes(id))
      ) {
        previous.messages.push(message);
      } else if (previous?.kind === "tool") {
        // Keep consecutive orphan results together without pairing them with
        // a user or plain assistant message.
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

/**
 * Loads this session's compaction segments from
 * `AgentMemorySession.metadata.compaction`. Defensive: entries with a wrong
 * shape/kind or non-integer `upToPosition` are dropped; results are sorted by
 * `upToPosition` ascending. Returns [] when the session or segments are
 * missing.
 */
export async function loadCompactionSegments(
  sessionId: string,
  userId?: string | null,
): Promise<CompactionSegment[]> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId, userId);
  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { metadata: true },
  });
  if (!session) return [];

  const metadata = session.metadata;
  if (!isRecord(metadata) || !Array.isArray(metadata.compaction)) return [];

  const segments: CompactionSegment[] = [];
  for (const entry of metadata.compaction) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry.upToPosition !== "number" ||
      !Number.isInteger(entry.upToPosition) ||
      entry.upToPosition < 1
    ) {
      continue;
    }
    const createdAt =
      typeof entry.createdAt === "string" && entry.createdAt.length > 0
        ? entry.createdAt
        : new Date().toISOString();
    if (entry.kind === "summarized") {
      if (typeof entry.summary !== "string") continue;
      segments.push({
        kind: "summarized",
        upToPosition: entry.upToPosition,
        summary: entry.summary,
        createdAt,
      });
    } else if (entry.kind === "dropped") {
      segments.push({
        kind: "dropped",
        upToPosition: entry.upToPosition,
        createdAt,
      });
    }
  }

  segments.sort((a, b) => a.upToPosition - b.upToPosition);
  return segments;
}

/**
 * Pure view builder for the agent context: one system summary message per
 * `summarized` segment (in order; `dropped` segments contribute nothing),
 * followed by the rows with `position > max(upToPosition)` in original order.
 */
export function buildCompactedView(
  rows: Array<{ position: number; message: Message }>,
  segments: CompactionSegment[],
): Message[] {
  const sorted = [...segments].sort((a, b) => a.upToPosition - b.upToPosition);
  const coveredUpTo =
    sorted.length === 0 ? -1 : sorted[sorted.length - 1]!.upToPosition;

  const view: Message[] = [];
  for (const segment of sorted) {
    if (segment.kind === "summarized") {
      view.push({
        role: "system",
        content: segment.summary,
        metadata: { kind: "summary" },
      } as Message);
    }
  }
  for (const row of rows) {
    if (row.position > coveredUpTo) view.push(row.message);
  }
  return view;
}

function strictMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  const parts: string[] = [];
  for (const value of message.content) {
    if (!isRecord(value)) continue;
    if (value.type === "text" && typeof value.text === "string") {
      parts.push(value.text);
      continue;
    }
    if (value.type === "tool-call") {
      const name = typeof value.toolName === "string" ? value.toolName : "tool";
      const input = safeSummaryJson(value.input);
      let serializedInput: string | undefined;
      try {
        const serialized = JSON.stringify(input);
        serializedInput = serialized === undefined ? undefined : serialized;
      } catch {
        serializedInput = undefined;
      }
      parts.push(
        serializedInput === undefined
          ? `[tool call ${name}]`
          : `[tool call ${name} input ${serializedInput}]`,
      );
      continue;
    }
    if (value.type !== "tool-result" || !isRecord(value.output)) continue;

    const output = value.output;
    if (
      (output.type === "text" || output.type === "error-text") &&
      typeof output.value === "string"
    ) {
      parts.push(output.value);
    } else if (
      (output.type === "json" || output.type === "error-json") &&
      output.value !== undefined
    ) {
      try {
        parts.push(JSON.stringify(safeSummaryJson(output.value)));
      } catch {
        // Ignore an unserializable result and keep the rest of the turn.
      }
    } else if (output.type === "execution-denied") {
      parts.push(
        typeof output.reason === "string"
          ? output.reason
          : "Tool execution was denied.",
      );
    } else if (output.type === "content" && Array.isArray(output.value)) {
      for (const content of output.value) {
        if (
          isRecord(content) &&
          content.type === "text" &&
          typeof content.text === "string"
        ) {
          parts.push(content.text);
        }
      }
    }
  }
  return parts.join("\n");
}

function isLikelyBase64(value: string): boolean {
  if (/^data:[^,]+;base64,/i.test(value)) return true;
  return (
    value.length >= 32 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    (value.includes("=") || value.length >= 32)
  );
}

function safeSummaryJson(value: unknown, key?: string): unknown {
  const keyLooksBinary =
    key !== undefined && /(?:base64|bytes|blob|encoded|binary)/i.test(key);
  const dataKeyLooksBinary =
    typeof value === "string" &&
    key === "data" &&
    value.length >= 8 &&
    /=+$/.test(value) &&
    /^[A-Za-z0-9+/]+={1,2}$/.test(value);
  if (
    typeof value === "string" &&
    (keyLooksBinary || dataKeyLooksBinary || isLikelyBase64(value))
  ) {
    return "[redacted binary data]";
  }
  if (Array.isArray(value)) return value.map((item) => safeSummaryJson(item));
  if (!isRecord(value)) return value;
  if (value.type === "image") {
    return {
      type: "image",
      ...(typeof value.mediaType === "string"
        ? { mediaType: value.mediaType }
        : {}),
    };
  }
  if (value.type === "file") {
    return {
      type: "file",
      ...(typeof value.mediaType === "string"
        ? { mediaType: value.mediaType }
        : {}),
      ...(typeof value.filename === "string"
        ? { filename: value.filename }
        : {}),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      safeSummaryJson(nested, nestedKey),
    ]),
  );
}

/** `[role] text` line; falls back to sanitized JSON when no text is available. */
export function renderMessageForSummary(
  message: Message,
  extractText: typeof extractTextFromMessageJson,
): string {
  const text = strictMessageText(message) || extractText(message);
  if (text.trim().length > 0) {
    return `[${message.role}] ${text}`;
  }
  try {
    return `[${message.role}] ${JSON.stringify(safeSummaryJson(message))}`;
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
  return createCompletionModel("openai/gpt-5.6-luna");
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
  const { extract } = await import("@anvia/core/extractor");
  const result = await extract({
    model: input.model,
    text,
    outputSchema: summarySchema,
    instructions: [
      COMPACTION_SUMMARY_INSTRUCTIONS,
      `Token budget: at most ${input.budgetTokens} tokens for the summary.`,
    ].join("\n"),
    retries: { maxAttempts: 2 },
  });
  return { summary: result.output.summary.trim(), usage: result.usage };
}

/**
 * Compacts a session's memory without touching rows: summarizes the prefix
 * with Luna and records the coverage as `CompactionSegment`s in
 * `AgentMemorySession.metadata.compaction`. Truncation is only a backstop
 * after a successful summarize (recorded as a `dropped` segment) — a
 * summarize failure aborts compaction entirely (returns skipped). Throws only
 * on DB errors.
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
    select: { id: true, metadata: true },
  });
  if (!session) return { skipped: true, reason: "below-threshold" };

  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: session.id },
    orderBy: { position: "asc" },
    select: { position: true, message: true },
  });
  const filteredRows = rows
    .map((row) => ({ position: row.position, message: parseMessage(row.message) }))
    .filter(
      (row) =>
        !(isRecord(row.message.metadata) && row.message.metadata.kind === "error"),
    );

  const segments = await loadCompactionSegments(input.sessionId, input.userId);
  const coveredUpTo =
    segments.length === 0 ? -1 : segments[segments.length - 1]!.upToPosition;

  const triggerTokens = Math.floor(input.windowTokens * input.triggerRatio);
  const targetTokens = Math.floor(input.windowTokens * input.targetRatio);
  const beforeTokens = estimateMessagesTokens(
    buildCompactedView(filteredRows, segments),
  );
  if (beforeTokens <= triggerTokens) return { skipped: true, reason: "below-threshold" };

  const activeRows = filteredRows.filter((row) => row.position > coveredUpTo);
  const groups = groupMemoryMessages(activeRows.map((row) => row.message));
  const boundary = findCompactionBoundary(groups, input.keepTurns);
  const prefixCount = groups
    .slice(0, boundary)
    .reduce((total, group) => total + group.messages.length, 0);
  if (prefixCount === 0) {
    // Nothing above the covered range to summarize (e.g. only system rows
    // remain uncovered, or everything is already covered) — the compacted
    // view estimate is driven by summaries alone, which is not compactable.
    console.log(
      `[compaction] skipped below-threshold ${input.sessionId}: no rows above covered range (coveredUpTo=${coveredUpTo})`,
    );
    return { skipped: true, reason: "below-threshold" };
  }
  const prefixRows = activeRows.slice(0, prefixCount);
  const suffixRows = activeRows.slice(prefixCount);

  const summaryBudget = Math.floor(input.windowTokens * input.summaryBudgetRatio);
  let summaryText: string;
  try {
    const summarized = await summarizeMessages({
      model: await lunaModel(),
      messages: prefixRows.map((row) => row.message),
      budgetTokens: summaryBudget,
    });
    summaryText = summarized.summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[compaction] summarize failed ${input.sessionId}: ${message}`);
    return { skipped: true, reason: "summarize-failed", error: message };
  }

  let truncatedGroups = 0;
  let droppedSegment: CompactionSegment | null = null;
  const summaryMessage: Message = {
    role: "system",
    content: summaryText,
    metadata: { kind: "summary" },
  } as Message;

  const afterSummaryTokens = estimateMessagesTokens([
    summaryMessage,
    ...suffixRows.map((row) => row.message),
  ]);
  if (afterSummaryTokens > targetTokens) {
    const suffixGroups = groups.slice(boundary);
    const result = truncateGroupsToTarget(suffixGroups, targetTokens);
    truncatedGroups = result.removed.length;
    if (truncatedGroups > 0) {
      // Removed groups are a contiguous prefix of the suffix (system groups
      // in between are never removed but are covered by the dropped range).
      const lastRemovedIndex = Math.max(
        ...result.removed.map((group) => suffixGroups.indexOf(group)),
      );
      const droppedMessageCount = suffixGroups
        .slice(0, lastRemovedIndex + 1)
        .reduce((total, group) => total + group.messages.length, 0);
      const droppedEndRow = activeRows[prefixCount + droppedMessageCount - 1];
      if (droppedEndRow && droppedEndRow.position > coveredUpTo) {
        droppedSegment = {
          kind: "dropped",
          upToPosition: droppedEndRow.position,
          createdAt: new Date().toISOString(),
        };
      }
    }
    // Safety: if the summary alone still exceeds the target, summarize tighter once.
    if (estimateMessagesTokens([summaryMessage]) > targetTokens) {
      try {
        const tighter = await summarizeMessages({
          model: await lunaModel(),
          messages: prefixRows.map((row) => row.message),
          budgetTokens: Math.max(64, Math.floor(targetTokens * 0.5)),
        });
        summaryText = tighter.summary;
      } catch {
        // Keep the first summary; the run proceeds (honest provider error later if any).
      }
    }
  }

  const lastPrefixRow = prefixRows[prefixRows.length - 1]!;
  const newSegments: CompactionSegment[] = [
    ...segments,
    {
      kind: "summarized",
      upToPosition: lastPrefixRow.position,
      summary: summaryText,
      createdAt: new Date().toISOString(),
    },
    ...(droppedSegment ? [droppedSegment] : []),
  ];

  const existingMetadata = isRecord(session.metadata) ? session.metadata : {};
  await prisma.agentMemorySession.update({
    where: { id: session.id },
    data: {
      metadata: {
        ...existingMetadata,
        compaction: newSegments,
      } as Prisma.InputJsonValue,
    },
  });

  const afterTokens = estimateMessagesTokens(
    buildCompactedView(filteredRows, newSegments),
  );

  return {
    skipped: false,
    stats: {
      beforeTokens,
      afterTokens,
      summarizedMessages: prefixRows.length,
      truncatedGroups,
      summaryTokens: estimateTextTokens(summaryText),
    },
  };
}
