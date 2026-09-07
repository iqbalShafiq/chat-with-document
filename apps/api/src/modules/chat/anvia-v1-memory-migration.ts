import {
  isJsonValue,
  isMessage,
  parseMessage,
  type JsonObject,
  type JsonValue,
  type Message,
} from "@anvia/core";

type RecordValue = Record<string, unknown>;

type ToolCallRecord = {
  toolName: string;
  callId?: string;
};

type NormalizationState = {
  toolCalls: Map<string, ToolCallRecord[]>;
};

export type NormalizedMessageResult =
  | { status: "unchanged"; message: Message }
  | { status: "converted"; message: Message }
  | { status: "rejected"; reason: string };

export type NormalizedMessageSequence =
  | { status: "unchanged" | "converted"; messages: Message[] }
  | { status: "rejected"; reason: string; index: number };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(reason: string): NormalizedMessageResult {
  return { status: "rejected", reason };
}

function optionalString(
  value: RecordValue,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (!hasOwn(value, key) || value[key] === undefined) {
    return { ok: true, value: undefined };
  }
  return typeof value[key] === "string"
    ? { ok: true, value: value[key] }
    : { ok: false, reason: `${key} must be a string` };
}

function requiredString(
  value: RecordValue,
  key: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value[key] !== "string" || value[key].trim().length === 0) {
    return { ok: false, reason: `${key} must be a non-empty string` };
  }
  return { ok: true, value: value[key] };
}

function stringValue(
  value: RecordValue,
  key: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value[key] !== "string") {
    return { ok: false, reason: `${key} must be a string` };
  }
  return { ok: true, value: value[key] };
}

function normalizeMetadata(
  value: RecordValue,
): { ok: true; value: JsonObject | undefined } | { ok: false; reason: string } {
  if (!hasOwn(value, "metadata") || value.metadata === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value.metadata) || !isJsonValue(value.metadata)) {
    return {
      ok: false,
      reason: "metadata must be a strict JSON object for v1",
    };
  }
  return { ok: true, value: value.metadata as JsonObject };
}

function optionalDetail(
  value: RecordValue,
): { ok: true; value: "auto" | "low" | "high" | undefined } | { ok: false; reason: string } {
  if (!hasOwn(value, "detail") || value.detail === undefined) {
    return { ok: true, value: undefined };
  }
  if (value.detail === "auto" || value.detail === "low" || value.detail === "high") {
    return { ok: true, value: value.detail };
  }
  return { ok: false, reason: "detail must be auto, low, or high" };
}

function normalizeTextPart(
  value: RecordValue,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  const text = stringValue(value, "text");
  if (!text.ok) return text;
  const signature = optionalString(value, "signature");
  if (!signature.ok) return signature;
  return {
    ok: true,
    value: {
      type: "text",
      text: text.value,
      ...(signature.value === undefined ? {} : { signature: signature.value }),
    },
  };
}

function normalizeLegacyImagePart(
  value: RecordValue,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  if (!isRecord(value.source)) return { ok: false, reason: "image source is missing" };
  const sourceType = requiredString(value.source, "type");
  if (!sourceType.ok) return sourceType;
  const detail = optionalDetail(value);
  if (!detail.ok) return detail;
  const mediaType = optionalString(value, "mediaType");
  if (!mediaType.ok) return mediaType;

  if (sourceType.value === "url") {
    const url = requiredString(value.source, "url");
    if (!url.ok) return url;
    return {
      ok: true,
      value: {
        type: "image",
        image: { type: "url", url: url.value },
        ...(mediaType.value === undefined ? {} : { mediaType: mediaType.value }),
        ...(detail.value === undefined ? {} : { detail: detail.value }),
      },
    };
  }
  if (sourceType.value === "base64") {
    const data = requiredString(value.source, "data");
    if (!data.ok) return data;
    const sourceMediaType = requiredString(value.source, "mediaType");
    if (!sourceMediaType.ok) return sourceMediaType;
    return {
      ok: true,
      value: {
        type: "image",
        image: { type: "data", data: data.value },
        mediaType: mediaType.value ?? sourceMediaType.value,
        ...(detail.value === undefined ? {} : { detail: detail.value }),
      },
    };
  }
  return { ok: false, reason: `unsupported image source type: ${sourceType.value}` };
}

function normalizeLegacyDocumentPart(
  value: RecordValue,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  if (!isRecord(value.source)) return { ok: false, reason: "document source is missing" };
  const sourceType = requiredString(value.source, "type");
  if (!sourceType.ok) return sourceType;
  const filename = optionalString(value.source, "filename");
  if (!filename.ok) return filename;

  if (sourceType.value === "url" || sourceType.value === "base64") {
    const dataKey = sourceType.value === "url" ? "url" : "data";
    const data = requiredString(value.source, dataKey);
    if (!data.ok) return data;
    const mediaType = requiredString(value.source, "mediaType");
    if (!mediaType.ok) return mediaType;
    return {
      ok: true,
      value: {
        type: "file",
        data: { type: sourceType.value, [dataKey]: data.value },
        mediaType: mediaType.value,
        ...(filename.value === undefined ? {} : { filename: filename.value }),
      },
    };
  }

  if (sourceType.value === "text") {
    const text = stringValue(value.source, "text");
    if (!text.ok) return text;
    const mediaType = optionalString(value.source, "mediaType");
    if (!mediaType.ok) return mediaType;
    if (mediaType.value === undefined && filename.value !== undefined) {
      return {
        ok: false,
        reason: "text document filename cannot be preserved without mediaType",
      };
    }
    if (mediaType.value === undefined) {
      return { ok: true, value: { type: "text", text: text.value } };
    }
    return {
      ok: true,
      value: {
        type: "file",
        data: { type: "text", text: text.value },
        mediaType: mediaType.value,
        ...(filename.value === undefined ? {} : { filename: filename.value }),
      },
    };
  }
  return { ok: false, reason: `unsupported document source type: ${sourceType.value}` };
}

function normalizeLegacyUserPart(
  value: unknown,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, reason: "user content part is malformed" };
  }
  if (value.type === "text") return normalizeTextPart(value);
  if (value.type === "image") return normalizeLegacyImagePart(value);
  if (value.type === "document") return normalizeLegacyDocumentPart(value);
  return { ok: false, reason: `unsupported user content part: ${value.type}` };
}

function normalizeReasoningDetail(
  value: unknown,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, reason: "reasoning detail is malformed" };
  }
  if (value.type === "text" || value.type === "summary") {
    const text = stringValue(value, "text");
    if (!text.ok) return text;
    const signature = optionalString(value, "signature");
    if (!signature.ok) return signature;
    return {
      ok: true,
      value: {
        type: value.type,
        text: text.value,
        ...(value.type === "text" && signature.value !== undefined
          ? { signature: signature.value }
          : {}),
      },
    };
  }
  if (value.type === "encrypted" || value.type === "redacted") {
    const data = requiredString(value, "data");
    if (!data.ok) return data;
    return { ok: true, value: { type: value.type, data: data.value } };
  }
  return { ok: false, reason: `unsupported reasoning detail: ${value.type}` };
}

function normalizeLegacyReasoning(
  value: RecordValue,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  const text = stringValue(value, "text");
  if (!text.ok) return text;
  const id = optionalString(value, "id");
  if (!id.ok) return id;
  const output: RecordValue = {
    type: "reasoning",
    text: text.value,
    ...(id.value === undefined ? {} : { id: id.value }),
  };
  if (hasOwn(value, "content")) {
    if (!Array.isArray(value.content)) {
      return { ok: false, reason: "reasoning content must be an array" };
    }
    const details: RecordValue[] = [];
    for (const detail of value.content) {
      const normalized = normalizeReasoningDetail(detail);
      if (!normalized.ok) return normalized;
      details.push(normalized.value);
    }
    output.details = details;
  }
  return { ok: true, value: output };
}

function parseToolArguments(value: unknown):
  | { ok: true; value: JsonValue }
  | { ok: false; reason: string } {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isJsonValue(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, reason: "tool call arguments are not strict JSON" };
    } catch {
      return { ok: false, reason: "tool call arguments are invalid JSON" };
    }
  }
  return isJsonValue(value)
    ? { ok: true, value }
    : { ok: false, reason: "tool call arguments are not strict JSON" };
}

function normalizeLegacyToolCall(
  value: RecordValue,
): { ok: true; value: RecordValue; call: { id: string; record: ToolCallRecord } } | { ok: false; reason: string } {
  const id = requiredString(value, "id");
  if (!id.ok) return id;
  if (!isRecord(value.function)) {
    return { ok: false, reason: "tool call function is missing" };
  }
  const toolName = requiredString(value.function, "name");
  if (!toolName.ok) return toolName;
  if (!hasOwn(value.function, "arguments")) {
    return { ok: false, reason: "tool call arguments are missing" };
  }
  const input = parseToolArguments(value.function.arguments);
  if (!input.ok) return input;
  const callId = optionalString(value, "callId");
  if (!callId.ok) return callId;
  const signature = optionalString(value, "signature");
  if (!signature.ok) return signature;
  if (hasOwn(value, "additionalParams") && value.additionalParams !== undefined) {
    return { ok: false, reason: "tool call additionalParams cannot be represented in v1" };
  }
  return {
    ok: true,
    value: {
      type: "tool-call",
      toolCallId: id.value,
      toolName: toolName.value,
      input: input.value,
      ...(callId.value === undefined ? {} : { callId: callId.value }),
      ...(signature.value === undefined ? {} : { signature: signature.value }),
    },
    call: {
      id: id.value,
      record: {
        toolName: toolName.value,
        ...(callId.value === undefined ? {} : { callId: callId.value }),
      },
    },
  };
}

function normalizeLegacyToolResultContent(
  value: unknown,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, reason: "tool result content is malformed" };
  }
  if (value.type === "text") {
    const text = stringValue(value, "text");
    if (!text.ok) return text;
    return { ok: true, value: { type: "text", text: text.value } };
  }
  if (value.type === "image") {
    const data = requiredString(value, "data");
    if (!data.ok) return data;
    const mediaType = requiredString(value, "mediaType");
    if (!mediaType.ok) return mediaType;
    return {
      ok: true,
      value: {
        type: "file",
        data: { type: "data", data: data.value },
        mediaType: mediaType.value,
      },
    };
  }
  return { ok: false, reason: `unsupported tool result content: ${value.type}` };
}

function normalizeLegacyToolResult(
  value: RecordValue,
  state: NormalizationState,
): { ok: true; value: RecordValue } | { ok: false; reason: string } {
  const id = requiredString(value, "id");
  if (!id.ok) return id;
  const matches = state.toolCalls.get(id.value) ?? [];
  if (matches.length === 0) {
    return { ok: false, reason: `orphan tool result ${id.value}` };
  }
  if (matches.length !== 1) {
    return { ok: false, reason: `ambiguous tool result ${id.value}` };
  }
  const match = matches[0]!;
  const toolName = optionalString(value, "toolName");
  if (!toolName.ok) return toolName;
  if (toolName.value !== undefined && toolName.value !== match.toolName) {
    return { ok: false, reason: `tool result ${id.value} toolName does not match its call` };
  }
  const callId = optionalString(value, "callId");
  if (!callId.ok) return callId;
  if (callId.value !== undefined && match.callId !== undefined && callId.value !== match.callId) {
    return { ok: false, reason: `tool result ${id.value} callId does not match its call` };
  }
  if (!Array.isArray(value.content)) {
    return { ok: false, reason: `tool result ${id.value} content must be an array` };
  }
  const content: RecordValue[] = [];
  for (const item of value.content) {
    const normalized = normalizeLegacyToolResultContent(item);
    if (!normalized.ok) return normalized;
    content.push(normalized.value);
  }
  return {
    ok: true,
    value: {
      type: "tool-result",
      toolCallId: id.value,
      toolName: match.toolName,
      output: { type: "content", value: content },
      ...(callId.value ?? match.callId
        ? { callId: callId.value ?? match.callId }
        : {}),
    },
  };
}

function registerToolCalls(message: Message, state: NormalizationState): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part.type !== "tool-call") continue;
    const calls = state.toolCalls.get(part.toolCallId) ?? [];
    calls.push({
      toolName: part.toolName,
      ...(part.callId === undefined ? {} : { callId: part.callId }),
    });
    state.toolCalls.set(part.toolCallId, calls);
  }
}

function parseConvertedMessage(
  value: RecordValue,
): { ok: true; message: Message } | { ok: false; reason: string } {
  try {
    return { ok: true, message: parseMessage(value) };
  } catch {
    return { ok: false, reason: "converted message failed strict v1 validation" };
  }
}

function normalizeLegacyMessage(
  value: RecordValue,
  state: NormalizationState,
): NormalizedMessageResult {
  if (typeof value.role !== "string") return fail("message role is missing");
  const metadata = normalizeMetadata(value);
  if (!metadata.ok) return fail(metadata.reason);

  if (value.role === "system") {
    if (typeof value.content !== "string") return fail("system content must be text");
    const parsed = parseConvertedMessage({
      role: "system",
      content: value.content,
      ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
    });
    return parsed.ok ? { status: "converted", message: parsed.message } : fail(parsed.reason);
  }

  if (value.role === "user") {
    if (typeof value.content === "string") {
      const parsed = parseConvertedMessage({
        role: "user",
        content: value.content,
        ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
      });
      return parsed.ok ? { status: "converted", message: parsed.message } : fail(parsed.reason);
    }
    if (!Array.isArray(value.content)) return fail("user content must be an array");
    const content: RecordValue[] = [];
    for (const item of value.content) {
      const normalized = normalizeLegacyUserPart(item);
      if (!normalized.ok) return fail(normalized.reason);
      content.push(normalized.value);
    }
    const parsed = parseConvertedMessage({
      role: "user",
      content,
      ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
    });
    return parsed.ok ? { status: "converted", message: parsed.message } : fail(parsed.reason);
  }

  if (value.role === "assistant") {
    const id = optionalString(value, "id");
    if (!id.ok) return fail(id.reason);
    const content: RecordValue[] = [];
    const calls: Array<{ id: string; record: ToolCallRecord }> = [];
    if (typeof value.content === "string") {
      const parsed = parseConvertedMessage({
        role: "assistant",
        content: value.content,
        ...(id.value === undefined ? {} : { id: id.value }),
        ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
      });
      if (!parsed.ok) return fail(parsed.reason);
      registerToolCalls(parsed.message, state);
      return { status: "converted", message: parsed.message };
    }
    if (!Array.isArray(value.content)) return fail("assistant content must be an array");
    for (const item of value.content) {
      if (!isRecord(item) || typeof item.type !== "string") {
        return fail("assistant content part is malformed");
      }
      let normalized:
        | { ok: true; value: RecordValue }
        | { ok: false; reason: string };
      if (item.type === "text") normalized = normalizeTextPart(item);
      else if (item.type === "image") normalized = normalizeLegacyImagePart(item);
      else if (item.type === "reasoning") normalized = normalizeLegacyReasoning(item);
      else if (item.type === "tool_call") normalized = normalizeLegacyToolCall(item);
      else normalized = { ok: false, reason: `unsupported assistant content part: ${item.type}` };
      if (!normalized.ok) return fail(normalized.reason);
      content.push(normalized.value);
      if (item.type === "tool_call") {
        const toolCall = normalizeLegacyToolCall(item);
        if (!toolCall.ok) return fail(toolCall.reason);
        calls.push(toolCall.call);
      }
    }
    const parsed = parseConvertedMessage({
      role: "assistant",
      content,
      ...(id.value === undefined ? {} : { id: id.value }),
      ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
    });
    if (!parsed.ok) return fail(parsed.reason);
    for (const call of calls) {
      const existing = state.toolCalls.get(call.id) ?? [];
      existing.push(call.record);
      state.toolCalls.set(call.id, existing);
    }
    return { status: "converted", message: parsed.message };
  }

  if (value.role === "tool") {
    if (!Array.isArray(value.content)) return fail("tool content must be an array");
    const content: RecordValue[] = [];
    for (const item of value.content) {
      if (!isRecord(item) || item.type !== "tool_result") {
        return fail("unsupported tool content part");
      }
      const normalized = normalizeLegacyToolResult(item, state);
      if (!normalized.ok) return fail(normalized.reason);
      content.push(normalized.value);
    }
    const parsed = parseConvertedMessage({
      role: "tool",
      content,
      ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
    });
    return parsed.ok ? { status: "converted", message: parsed.message } : fail(parsed.reason);
  }

  return fail(`unsupported message role: ${value.role}`);
}

function normalizeWithState(
  value: unknown,
  state: NormalizationState,
): NormalizedMessageResult {
  if (isMessage(value)) {
    registerToolCalls(value, state);
    return { status: "unchanged", message: value };
  }
  if (!isRecord(value)) return fail("message must be an object");
  return normalizeLegacyMessage(value, state);
}

export function normalizeMemoryMessage(value: unknown): NormalizedMessageResult {
  return normalizeWithState(value, { toolCalls: new Map() });
}

export function normalizeMemoryMessageSequence(
  values: unknown[],
): NormalizedMessageSequence {
  const state: NormalizationState = { toolCalls: new Map() };
  const messages: Message[] = [];
  let converted = false;
  for (const [index, value] of values.entries()) {
    const result = normalizeWithState(value, state);
    if (result.status === "rejected") {
      return { status: "rejected", index, reason: result.reason };
    }
    messages.push(result.message);
    converted ||= result.status === "converted";
  }
  return { status: converted ? "converted" : "unchanged", messages };
}

export type MemoryMigrationMessageRow = {
  id: string;
  memorySessionId: string;
  position: number;
  message: unknown;
};

export type MemoryMigrationErrorRow = {
  id: string;
  memorySessionId: string;
  messages: unknown;
};

export type MemoryMigrationSessionRow = {
  id: string;
};

export type MemoryMigrationTransaction = {
  agentMemoryMessage: {
    updateMany(args: {
      where: { id: string; message: { equals: unknown } };
      data: { message: Message };
    }): Promise<{ count: number }>;
  };
  agentMemoryError: {
    updateMany(args: {
      where: { id: string; messages: { equals: unknown } };
      data: { messages: Message[] };
    }): Promise<{ count: number }>;
  };
};

export type MemoryMigrationPageArgs = {
  where?: { memorySessionId?: string };
  orderBy?: unknown;
  select?: unknown;
  take?: number;
  skip?: number;
  cursor?: { id: string };
};

export type MemoryMigrationClient = {
  agentMemorySession: {
    findMany(args?: MemoryMigrationPageArgs): Promise<MemoryMigrationSessionRow[]>;
  };
  agentMemoryMessage: {
    findMany(args?: MemoryMigrationPageArgs): Promise<MemoryMigrationMessageRow[]>;
  };
  agentMemoryError: {
    findMany(args?: MemoryMigrationPageArgs): Promise<MemoryMigrationErrorRow[]>;
  };
  $transaction<T>(operation: (tx: MemoryMigrationTransaction) => Promise<T>): Promise<T>;
};

export type MemoryMigrationCounts = {
  total: number;
  unchanged: number;
  converted: number;
  rejected: number;
};

export type MemoryMigrationIssue = {
  table: "message" | "error";
  rowId: string;
  memorySessionId: string;
  index?: number;
  reason: string;
};

export type MemoryMigrationAudit = {
  blocked: boolean;
  messages: MemoryMigrationCounts;
  errors: MemoryMigrationCounts;
  issues: MemoryMigrationIssue[];
  pages: {
    messages: number;
    errors: number;
  };
};

export const DEFAULT_MEMORY_MIGRATION_PAGE_SIZE = 500;
export const MAX_MEMORY_MIGRATION_ISSUE_SAMPLES = 100;

export class MemoryMigrationDriftError extends Error {
  readonly table: "message" | "error";
  readonly rowId: string;

  constructor(table: "message" | "error", rowId: string) {
    // Row identifiers remain structured for operator diagnostics, but never
    // enter an exception message that a CLI or queue logger may expose.
    super("memory migration aborted because a row changed during the audit");
    this.name = "MemoryMigrationDriftError";
    this.table = table;
    this.rowId = rowId;
  }
}

export class MemoryMigrationWriteError extends Error {
  readonly table: "message" | "error";
  readonly rowId: string;

  constructor(table: "message" | "error", rowId: string, reason: string) {
    // `reason` can include legacy tool/call identifiers or user content. Keep
    // it out of the externally rendered error while retaining table/id as
    // structured internal fields for the caller.
    void reason;
    super("memory migration aborted because a row could not be normalized");
    this.name = "MemoryMigrationWriteError";
    this.table = table;
    this.rowId = rowId;
  }
}

type SequenceInspection = {
  results: NormalizedMessageResult[];
  messages: Message[];
  issues: Array<{ index: number; reason: string }>;
};

function inspectSequence(values: unknown[]): SequenceInspection {
  const state: NormalizationState = { toolCalls: new Map() };
  const results: NormalizedMessageResult[] = [];
  const messages: Message[] = [];
  const issues: Array<{ index: number; reason: string }> = [];
  for (const [index, value] of values.entries()) {
    const result = normalizeWithState(value, state);
    results.push(result);
    if (result.status === "rejected") {
      issues.push({ index, reason: result.reason });
    } else {
      messages.push(result.message);
    }
  }
  return { results, messages, issues };
}

function emptyCounts(): MemoryMigrationCounts {
  return { total: 0, unchanged: 0, converted: 0, rejected: 0 };
}

function pageSizeOrDefault(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_MEMORY_MIGRATION_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("memory migration pageSize must be a positive integer");
  }
  return pageSize;
}

function sortMessagePage(rows: MemoryMigrationMessageRow[]): MemoryMigrationMessageRow[] {
  return [...rows].sort(
    (left, right) =>
      left.memorySessionId.localeCompare(right.memorySessionId) ||
      left.position - right.position ||
      left.id.localeCompare(right.id),
  );
}

function sortErrorPage(rows: MemoryMigrationErrorRow[]): MemoryMigrationErrorRow[] {
  return [...rows].sort(
    (left, right) =>
      left.memorySessionId.localeCompare(right.memorySessionId) ||
      left.id.localeCompare(right.id),
  );
}

type PageReader<T> = (
  args: MemoryMigrationPageArgs,
) => Promise<T[]>;

async function forEachPage<T>(input: {
  read: PageReader<T>;
  pageSize: number;
  orderBy: unknown;
  select: unknown;
  where?: MemoryMigrationPageArgs["where"];
  onPage: (rows: T[]) => Promise<void>;
}): Promise<number> {
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const args: MemoryMigrationPageArgs = {
      ...(input.where === undefined ? {} : { where: input.where }),
      orderBy: input.orderBy,
      select: input.select,
      take: input.pageSize,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    };
    const rows = await input.read(args);
    pages += 1;
    await input.onPage(rows);
    if (rows.length < input.pageSize) return pages;
    const last = rows[rows.length - 1];
    const lastRecord = last as unknown as { id?: unknown } | undefined;
    if (!lastRecord || typeof lastRecord.id !== "string") {
      throw new Error("memory migration pagination requires stable row ids");
    }
    const nextCursor = lastRecord.id;
    if (nextCursor === cursor) {
      throw new Error("memory migration pagination cursor did not advance");
    }
    cursor = nextCursor;
  }
}

function pushIssue(
  issues: MemoryMigrationIssue[],
  table: "message" | "error",
  row: { id: string; memorySessionId: string },
  reason: string,
  index?: number,
): void {
  if (issues.length >= MAX_MEMORY_MIGRATION_ISSUE_SAMPLES) return;
  issues.push({
    table,
    rowId: row.id,
    memorySessionId: row.memorySessionId,
    ...(index === undefined ? {} : { index }),
    reason,
  });
}

type ActiveMessageAudit = {
  memorySessionId: string;
  state: NormalizationState;
  index: number;
};

export async function auditMemoryStore(
  client: MemoryMigrationClient,
  options: { pageSize?: number } = {},
): Promise<MemoryMigrationAudit> {
  const pageSize = pageSizeOrDefault(options.pageSize);
  const messages = emptyCounts();
  const errors = emptyCounts();
  const issues: MemoryMigrationIssue[] = [];
  let activeMessage: ActiveMessageAudit | undefined;

  const messagePages = forEachPage({
    read: (args) => client.agentMemoryMessage.findMany(args),
    pageSize,
    orderBy: [
      { memorySessionId: "asc" },
      { position: "asc" },
      { id: "asc" },
    ],
    select: { id: true, memorySessionId: true, position: true, message: true },
    onPage: async (page) => {
      for (const row of sortMessagePage(page)) {
        if (activeMessage?.memorySessionId !== row.memorySessionId) {
          activeMessage = {
            memorySessionId: row.memorySessionId,
            state: { toolCalls: new Map() },
            index: 0,
          };
        }
        const index = activeMessage.index;
        activeMessage.index += 1;
        messages.total += 1;
        const result = normalizeWithState(row.message, activeMessage.state);
        if (result.status === "rejected") {
          messages.rejected += 1;
          pushIssue(issues, "message", row, result.reason, index);
        } else if (result.status === "converted") {
          messages.converted += 1;
        } else {
          messages.unchanged += 1;
        }
      }
    },
  });

  const errorPages = forEachPage({
    read: (args) => client.agentMemoryError.findMany(args),
    pageSize,
    orderBy: [{ memorySessionId: "asc" }, { id: "asc" }],
    select: { id: true, memorySessionId: true, messages: true },
    onPage: async (page) => {
      for (const row of sortErrorPage(page)) {
        errors.total += 1;
        if (!Array.isArray(row.messages)) {
          errors.rejected += 1;
          pushIssue(issues, "error", row, "failed-run messages must be an array");
          continue;
        }
        const inspected = inspectSequence(row.messages);
        if (inspected.issues.length > 0) {
          errors.rejected += 1;
          for (const issue of inspected.issues) {
            pushIssue(issues, "error", row, issue.reason, issue.index);
          }
        } else if (inspected.results.some((result) => result.status === "converted")) {
          errors.converted += 1;
        } else {
          errors.unchanged += 1;
        }
      }
    },
  });

  const [messagesPageCount, errorsPageCount] = await Promise.all([
    messagePages,
    errorPages,
  ]);
  return {
    blocked: messages.rejected > 0 || errors.rejected > 0,
    messages,
    errors,
    issues,
    pages: { messages: messagesPageCount, errors: errorsPageCount },
  };
}

type MessageWriteRow = MemoryMigrationMessageRow;
type ErrorWriteRow = MemoryMigrationErrorRow;

type PreparedMessageUpdate = { row: MessageWriteRow; message: Message };
type PreparedErrorUpdate = { row: ErrorWriteRow; messages: Message[] };

function prepareMessageUpdates(rows: MessageWriteRow[]): PreparedMessageUpdate[] {
  if (rows.length === 0) return [];
  const inspected = inspectSequence(rows.map((row) => row.message));
  const issue = inspected.issues[0];
  if (issue) {
    throw new MemoryMigrationWriteError(
      "message",
      rows[issue.index]?.id ?? rows[0]!.id,
      issue.reason,
    );
  }
  return rows.flatMap((row, index) => {
    const result = inspected.results[index]!;
    return result.status === "converted" ? [{ row, message: result.message }] : [];
  });
}

function prepareErrorUpdates(rows: ErrorWriteRow[]): PreparedErrorUpdate[] {
  const updates: PreparedErrorUpdate[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.messages)) {
      throw new MemoryMigrationWriteError(
        "error",
        row.id,
        "failed-run messages must be an array",
      );
    }
    const inspected = inspectSequence(row.messages);
    const issue = inspected.issues[0];
    if (issue) {
      throw new MemoryMigrationWriteError("error", row.id, issue.reason);
    }
    if (inspected.results.some((result) => result.status === "converted")) {
      updates.push({ row, messages: inspected.messages });
    }
  }
  return updates;
}

async function loadMemorySessionRows(
  client: MemoryMigrationClient,
  memorySessionId: string,
  pageSize: number,
): Promise<{ messages: MessageWriteRow[]; errors: ErrorWriteRow[] }> {
  const messages: MessageWriteRow[] = [];
  const errors: ErrorWriteRow[] = [];
  await forEachPage({
    read: (args) => client.agentMemoryMessage.findMany(args),
    where: { memorySessionId },
    pageSize,
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, memorySessionId: true, position: true, message: true },
    onPage: async (page) => {
      messages.push(...sortMessagePage(page));
    },
  });
  await forEachPage({
    read: (args) => client.agentMemoryError.findMany(args),
    where: { memorySessionId },
    pageSize,
    orderBy: [{ id: "asc" }],
    select: { id: true, memorySessionId: true, messages: true },
    onPage: async (page) => {
      errors.push(...sortErrorPage(page));
    },
  });
  return { messages, errors };
}

async function writeMemorySession(
  client: MemoryMigrationClient,
  rows: { messages: MessageWriteRow[]; errors: ErrorWriteRow[] },
): Promise<void> {
  const messageUpdates = prepareMessageUpdates(rows.messages);
  const errorUpdates = prepareErrorUpdates(rows.errors);
  if (messageUpdates.length === 0 && errorUpdates.length === 0) return;

  // Both tables for one memory session deliberately share one transaction.
  // Each update also carries the original JSON as a jsonb equality predicate;
  // PostgreSQL compares jsonb semantically, so object-key reordering is not a
  // false drift while a concurrent content change yields count=0.
  await client.$transaction(async (tx) => {
    for (const { row, message } of messageUpdates) {
      const result = await tx.agentMemoryMessage.updateMany({
        where: { id: row.id, message: { equals: row.message } },
        data: { message },
      });
      if (result.count !== 1) {
        throw new MemoryMigrationDriftError("message", row.id);
      }
    }
    for (const { row, messages } of errorUpdates) {
      const result = await tx.agentMemoryError.updateMany({
        where: { id: row.id, messages: { equals: row.messages } },
        data: { messages },
      });
      if (result.count !== 1) {
        throw new MemoryMigrationDriftError("error", row.id);
      }
    }
  });
}

async function writeMigratedRows(
  client: MemoryMigrationClient,
  options: { pageSize: number },
): Promise<void> {
  // Page the parent session table, then load and write one session at a time.
  // This retains neither all session IDs nor any converted message bodies.
  await forEachPage({
    read: (args) => client.agentMemorySession.findMany(args),
    pageSize: options.pageSize,
    orderBy: [{ id: "asc" }],
    select: { id: true },
    onPage: async (page) => {
      for (const session of page) {
        const rows = await loadMemorySessionRows(
          client,
          session.id,
          options.pageSize,
        );
        await writeMemorySession(client, rows);
      }
    },
  });
}

export async function migrateMemoryStore(
  client: MemoryMigrationClient,
  options: { write?: boolean; pageSize?: number } = {},
): Promise<MemoryMigrationAudit> {
  const pageSize = pageSizeOrDefault(options.pageSize);
  const audit = await auditMemoryStore(client, { pageSize });
  // Dry-run and a blocked audit are read-only. In particular, a bad row on a
  // later page must prevent every write from starting.
  if (options.write !== true || audit.blocked) return audit;
  if (audit.messages.converted === 0 && audit.errors.converted === 0) return audit;
  await writeMigratedRows(client, { pageSize });
  return audit;
}

function formatCounts(label: string, counts: MemoryMigrationCounts): string {
  return `${label} total=${counts.total} unchanged=${counts.unchanged} converted=${counts.converted} rejected=${counts.rejected}`;
}

export function formatMigrationSummary(
  audit: MemoryMigrationAudit,
  options: { write: boolean },
): string {
  return [
    `Anvia v1 memory migration ${options.write ? "write" : "dry-run"}`,
    formatCounts("messages", audit.messages),
    formatCounts("errors", audit.errors),
    `pages messages=${audit.pages.messages} errors=${audit.pages.errors}`,
    `status=${audit.blocked ? "blocked" : "ready"}`,
  ].join("\n");
}
