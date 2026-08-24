import {
  createMemoryScopeKey,
  type MemoryCompactionMessage,
  type MemoryStore,
  type Message,
} from "@anvia/core";
import { describe, expect, it } from "vitest";
import {
  createDefaultMemoryScopeKey,
  } from "./memory-scope.js";
import { createNonVisionMemoryProxy } from "./memory-sanitizer.js";
import {
  assertNativeStaticContextMatches,
  createNativeStaticContext,
  estimateNativeStaticContextTokens,
  NativeMemoryConfigurationError,
  resolveNativeMemoryPolicy,
  resolveModelTokenBudget,
} from "./memory-policy.js";
import { estimateStaticContextTokens } from "./context-usage.js";

function text(value: string): Message {
  return { role: "user", content: [{ type: "text", text: value }] } as Message;
}

describe("native Anvia v1 memory boundary", () => {
  it("derives one bounded token policy after static context and output reserve", () => {
    const staticContextTokens = estimateNativeStaticContextTokens({
      instructions: ["Keep answers grounded."],
      contextTexts: ["Document catalog"],
    });
    const policy = resolveNativeMemoryPolicy({
      contextWindowTokens: 1_000,
      maxInputTokens: 900,
      maxOutputTokens: 100,
      staticContextTokens,
    });
    expect(policy.version).toBe(1);
    expect(policy.savePolicy).toBe("turn");
    expect(policy.retentionRecentTokens).toBeLessThan(policy.triggerAfterTokens);
    expect(policy.compactorMaxTokens).toBeGreaterThan(0);
    expect(policy.conflictRetries).toBe(3);
  });

  it("treats nullable provider budgets as explicit catalog semantics", () => {
    const budget = resolveModelTokenBudget({
      contextWindowTokens: 1_000,
      maxInputTokens: null,
      maxOutputTokens: null,
    });
    const policy = resolveNativeMemoryPolicy({
      ...budget,
      staticContextTokens: 100,
    });

    expect(budget).toEqual({
      contextWindowTokens: 1_000,
      maxInputTokens: null,
      maxOutputTokens: null,
    });
    expect(policy.triggerAfterTokens).toBe(630);
    expect(policy.retentionRecentTokens).toBe(270);
  });

  it.each([
    ["context window", { contextWindowTokens: undefined }],
    ["context window", { contextWindowTokens: 0 }],
    ["input budget", { contextWindowTokens: 1_000, maxInputTokens: undefined }],
    ["input budget", { contextWindowTokens: 1_000, maxInputTokens: 0 }],
    ["output budget", { contextWindowTokens: 1_000, maxOutputTokens: undefined }],
    ["output budget", { contextWindowTokens: 1_000, maxOutputTokens: 0 }],
  ] as const)("fails closed for an invalid %s catalog value", (_field, value) => {
    expect(() => resolveModelTokenBudget(value)).toThrowError(
      NativeMemoryConfigurationError,
    );
  });

  it("fails closed when static context leaves no native memory budget", () => {
    expect(() =>
      resolveNativeMemoryPolicy({
        contextWindowTokens: 100,
        maxInputTokens: 100,
        maxOutputTokens: 10,
        staticContextTokens: 100,
      }),
    ).toThrowError(/NATIVE_MEMORY_CONFIGURATION_INVALID/);
  });

  it("freezes the complete static prompt surface before a recipe is serialized", () => {
    const staticContext = createNativeStaticContext({
      baseInstructions: "Base policy",
      instructions: ["Optional policy"],
      contextBlocks: [{ id: "project", text: "Project facts" }],
      toolDefinitions: [
        {
          name: "search_documents",
          description: "Search the authenticated documents",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      model: {
        contextWindowTokens: 1000,
        maxInputTokens: 900,
        maxOutputTokens: 100,
      },
    });

    expect(staticContext).toMatchObject({
      version: 1,
      instructions: { base: "Base policy", additional: ["Optional policy"] },
      context: [{ id: "project", text: "Project facts" }],
      tools: [
        expect.objectContaining({ name: "search_documents" }),
      ],
      model: {
        contextWindowTokens: 1000,
        maxInputTokens: 900,
        maxOutputTokens: 100,
      },
    });
    expect(staticContext.staticContextTokens).toBe(
      estimateNativeStaticContextTokens({
        baseInstructions: "Base policy",
        instructions: ["Optional policy"],
        contextBlocks: [{ id: "project", text: "Project facts" }],
        toolDefinitions: staticContext.tools,
      }),
    );
  });

  it("fails closed when resume reconstructs a different static tool surface", () => {
    const expected = createNativeStaticContext({
      baseInstructions: "Base policy",
      instructions: ["Optional policy"],
      contextBlocks: [{ id: "project", text: "Project facts" }],
      toolDefinitions: [
        {
          name: "search_documents",
          description: "Search the authenticated documents",
          parameters: { type: "object" },
        },
      ],
      model: {
        contextWindowTokens: 1000,
        maxInputTokens: 900,
        maxOutputTokens: 100,
      },
    });

    expect(() =>
      assertNativeStaticContextMatches({
        expected,
        expectedPolicyStaticContextTokens: expected.staticContextTokens,
        baseInstructions: "Base policy",
        instructions: ["Optional policy"],
        contextBlocks: [{ id: "project", text: "Project facts" }],
        toolDefinitions: [
          {
            name: "search_documents",
            description: "Search the authenticated documents",
            parameters: { type: "object", properties: { query: {} } },
          },
        ],
        model: {
          contextWindowTokens: 1000,
          maxInputTokens: 900,
          maxOutputTokens: 100,
        },
      }),
    ).toThrow(/native memory static context mismatch/);
  });

  it("uses Anvia's counter for the legacy static-context helper too", () => {
    const instructions = ["Keep answers grounded."];
    const contextBlocks = [{ text: "Document catalog" }];
    const tool = {
      name: "search_docs",
      description: "Search",
      parameters: { type: "object" },
    };
    expect(
      estimateStaticContextTokens({ instructions, contextBlocks, tools: [tool] }),
    ).toBe(
      estimateNativeStaticContextTokens({
        instructions,
        contextTexts: [contextBlocks[0]!.text, JSON.stringify(tool)],
      }),
    );
  });

  it("keeps the existing scope-key bytes by delegating to Anvia", async () => {
    const scope = { sessionId: "session-1", userId: "user-1" };
    expect(createDefaultMemoryScopeKey(scope.sessionId, scope.userId)).toBe(
      createMemoryScopeKey({ scope }),
    );
  });

  it("sanitizes native compaction snapshots for text-only models", async () => {
    const replacement: MemoryCompactionMessage = {
      role: "system",
      content: "summary",
      metadata: {
        anvia: { memoryCompaction: { version: 1, compactedMessageCount: 1 } },
      },
    };
    const inner: MemoryStore = {
      load: async () => [],
      append: async () => undefined,
      clear: async () => undefined,
      compaction: {
        snapshot: async () => ({
          revision: "r1",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "keep" },
                {
                  type: "image",
                  image: { type: "url", url: "https://example.com/a.png" },
                  mediaType: "image/png",
                },
              ],
            } as Message,
          ],
        }),
        replacePrefix: async (input) => {
          expect(input.replacement).toEqual(replacement);
          return { status: "committed" };
        },
      },
    };

    const proxy = createNonVisionMemoryProxy(inner);
    const snapshot = await proxy.compaction!.snapshot({
      scope: { sessionId: "session-1", userId: "user-1" },
    });
    expect(snapshot.messages).toEqual([text("keep")]);
    await expect(
      proxy.compaction!.replacePrefix({
        scope: { sessionId: "session-1", userId: "user-1" },
        revision: snapshot.revision,
        messageCount: 1,
        replacement,
        runId: "run-1",
      }),
    ).resolves.toEqual({ status: "committed" });
  });
});
