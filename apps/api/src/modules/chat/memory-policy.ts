import {
  estimateMemoryTokens,
  type Message,
  type ToolDefinition,
} from "@anvia/core";

export const NATIVE_MEMORY_POLICY_VERSION = 1 as const;
export const NATIVE_MEMORY_TRIGGER_RATIO = 0.7;
export const NATIVE_MEMORY_RETENTION_RATIO = 0.3;
export const NATIVE_MEMORY_CONFLICT_RETRIES = 3;

/**
 * A model's token catalog is part of the authenticated run contract. A
 * missing or malformed value must stop recipe construction; silently picking
 * a local number would make the native memory policy disagree with the
 * provider's actual limits.
 */
export class NativeMemoryConfigurationError extends Error {
  readonly code = "NATIVE_MEMORY_CONFIGURATION_INVALID" as const;

  constructor(reason: "context-window" | "input-budget" | "output-budget" | "available-memory") {
    super(`NATIVE_MEMORY_CONFIGURATION_INVALID: ${reason}`);
    this.name = "NativeMemoryConfigurationError";
  }
}

export type ModelTokenBudget = {
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
};

/** Validate and normalize exactly the nullable fields persisted in the model catalog. */
export function resolveModelTokenBudget(input: {
  contextWindowTokens?: number | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
}): ModelTokenBudget {
  const contextWindowTokens = requirePositiveInteger(
    input.contextWindowTokens,
    "context-window",
  );
  const maxInputTokens = input.maxInputTokens === null
    ? null
    : requirePositiveInteger(input.maxInputTokens, "input-budget");
  const maxOutputTokens = input.maxOutputTokens === null
    ? null
    : requirePositiveInteger(input.maxOutputTokens, "output-budget");

  if (maxInputTokens !== null && maxInputTokens > contextWindowTokens) {
    throw new NativeMemoryConfigurationError("input-budget");
  }
  if (
    maxInputTokens !== null &&
    maxOutputTokens !== null &&
    maxInputTokens + maxOutputTokens > contextWindowTokens
  ) {
    throw new NativeMemoryConfigurationError("available-memory");
  }

  return { contextWindowTokens, maxInputTokens, maxOutputTokens };
}

export type NativeMemoryPolicy = {
  version: typeof NATIVE_MEMORY_POLICY_VERSION;
  savePolicy: "turn";
  /** The complete frozen prompt/tool surface counted before serialization. */
  staticContextTokens: number;
  triggerAfterTokens: number;
  retentionRecentTokens: number;
  compactorMaxTokens: number;
  conflictRetries: number;
};

export type NativeStaticContext = {
  version: 1;
  instructions: {
    base: string;
    additional: string[];
  };
  context: Array<{ id: string; text: string }>;
  tools: ToolDefinition[];
  model: {
    contextWindowTokens: number;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
  };
  staticContextTokens: number;
};

/**
 * Count the same JSON-visible static surface that the Anvia completion request
 * receives. Instructions are one system prompt; context documents and tool
 * definitions retain their serialized ids/schema instead of counting only
 * their display text. This is deliberately provider-neutral and contains no
 * runtime model, store, MCP, or tool execution handle.
 */
export function estimateNativeStaticContextTokens(input: {
  baseInstructions?: string;
  instructions: readonly string[];
  contextTexts?: readonly string[];
  contextBlocks?: readonly { id: string; text: string }[];
  toolDefinitions?: readonly ToolDefinition[];
}): number {
  const base = input.baseInstructions?.trim() ?? "";
  const additional = input.instructions
    .map((instruction) => instruction.trim())
    .filter(Boolean);
  const instructionText = [...(base ? [base] : []), ...additional].join("\n\n");
  const context = input.contextBlocks
    ? input.contextBlocks.map((block) => JSON.stringify(block))
    : (input.contextTexts ?? []).filter((text) => text.trim().length > 0);
  const tools = (input.toolDefinitions ?? []).map((definition) =>
    JSON.stringify(definition),
  );
  const contents = [
    ...(instructionText ? [instructionText] : []),
    ...context,
    ...tools,
  ];
  return estimateMemoryTokens(
    contents.map((content) => ({ role: "system", content }) as Message),
  );
}

/** Build the immutable, JSON-only static surface stored in a run recipe. */
export function createNativeStaticContext(input: {
  baseInstructions: string;
  instructions: readonly string[];
  contextBlocks: readonly { id: string; text: string }[];
  toolDefinitions: readonly ToolDefinition[];
  model: {
    contextWindowTokens: number;
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
  };
}): NativeStaticContext {
  const instructions = input.instructions
    .map((instruction) => instruction.trim())
    .filter(Boolean);
  const context = input.contextBlocks
    .map((block) => ({ id: block.id, text: block.text.trim() }))
    .filter((block) => block.text.length > 0);
  const tools = input.toolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }));
  const staticContextTokens = estimateNativeStaticContextTokens({
    baseInstructions: input.baseInstructions,
    instructions,
    contextBlocks: context,
    toolDefinitions: tools,
  });
  return {
    version: 1,
    instructions: {
      base: input.baseInstructions.trim(),
      additional: instructions,
    },
    context,
    tools,
    model: {
      contextWindowTokens: input.model.contextWindowTokens,
      maxInputTokens: input.model.maxInputTokens ?? null,
      maxOutputTokens: input.model.maxOutputTokens ?? null,
    },
    staticContextTokens,
  };
}

/**
 * Verify that a worker rebuilt the same static surface that was budgeted at
 * start. The diagnostic intentionally exposes only counts, never prompt text,
 * tool arguments, or provider credentials.
 */
export function assertNativeStaticContextMatches(input: {
  expected: NativeStaticContext;
  baseInstructions: string;
  instructions: readonly string[];
  contextBlocks: readonly { id: string; text: string }[];
  toolDefinitions: readonly ToolDefinition[];
  model: {
    contextWindowTokens: number;
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
  };
  expectedPolicyStaticContextTokens: number;
}): void {
  const actual = createNativeStaticContext(input);
  const expectedJson = canonicalJson(input.expected);
  const actualJson = canonicalJson(actual);
  if (
    expectedJson !== actualJson ||
    input.expectedPolicyStaticContextTokens !== actual.staticContextTokens
  ) {
    throw new Error(
      "native memory static context mismatch " +
        "(expectedTokens=" +
        input.expected.staticContextTokens +
        ", actualTokens=" +
        actual.staticContextTokens +
        ", expectedTools=" +
        input.expected.tools.length +
        ", actualTools=" +
        actual.tools.length +
        ", expectedContext=" +
        input.expected.context.length +
        ", actualContext=" +
        actual.context.length +
        ")",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (typeof value === "object" && value !== null) {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) =>
          JSON.stringify(key) + ":" + canonicalJson(item),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

/**
 * Resolve the sole memory policy used by both fresh and resumed workers. The
 * model's static input and output reserve are removed before selecting native
 * memory thresholds, so the endpoint and Anvia Core observe one budget.
 */
export function resolveNativeMemoryPolicy(input: {
  contextWindowTokens?: number | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  staticContextTokens?: number;
}): NativeMemoryPolicy {
  const budget = resolveModelTokenBudget(input);
  const staticContextTokens = requireNonnegativeInteger(
    input.staticContextTokens ?? 0,
  );
  // A nullable max input means the provider gives no separate input cap, so
  // the persisted context window is the only authoritative input ceiling.
  const inputBudget = budget.maxInputTokens ?? budget.contextWindowTokens;
  // A nullable max output means no separate output reserve is catalogued. It
  // is not permission to invent a percentage-based reserve locally.
  const outputReserve = budget.maxOutputTokens ?? 0;
  const availableMemory = inputBudget - staticContextTokens - outputReserve;
  if (availableMemory < 4) {
    throw new NativeMemoryConfigurationError("available-memory");
  }
  const triggerAfterTokens = Math.floor(
    availableMemory * NATIVE_MEMORY_TRIGGER_RATIO,
  );
  const retentionRecentTokens = Math.floor(
    availableMemory * NATIVE_MEMORY_RETENTION_RATIO,
  );
  if (triggerAfterTokens < 2 || retentionRecentTokens < 1) {
    throw new NativeMemoryConfigurationError("available-memory");
  }
  const compactorMaxTokens = Math.min(4_096, Math.floor(retentionRecentTokens / 2));
  if (compactorMaxTokens < 1) {
    throw new NativeMemoryConfigurationError("available-memory");
  }

  return {
    version: NATIVE_MEMORY_POLICY_VERSION,
    savePolicy: "turn",
    staticContextTokens,
    triggerAfterTokens,
    retentionRecentTokens,
    // The compactor budget is derived only from the validated native memory
    // budget; it is never a fixed fallback for a missing model catalog value.
    compactorMaxTokens,
    conflictRetries: NATIVE_MEMORY_CONFLICT_RETRIES,
  };
}

function requirePositiveInteger(
  value: number | null | undefined,
  reason: "context-window" | "input-budget" | "output-budget",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new NativeMemoryConfigurationError(reason);
  }
  return value;
}

function requireNonnegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NativeMemoryConfigurationError("available-memory");
  }
  return value;
}
