import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_STREAM_PROTOCOL,
  parseClientStreamEvent,
  parseClientStreamRequest,
} from "@anvia/client";
import {
  isMemoryCompactionMessage,
  type Message,
  type MemoryCompactionMessage,
  type ToolDefinition,
} from "@anvia/core";
import {
  assertAgentInteractionResponse,
  parseAgentContinuation,
  parseAgentInteractionRequest,
} from "@anvia/core/agent/interactions";
import { describe, expect, it } from "vitest";
import {
  ChatDataSchemas,
  ChatMetadataSchema,
  createChatClientStream,
  gateRootInteraction,
  type ChatStreamEvent,
} from "./client-events.js";
import { parseChatClientRequest } from "./client-request.js";
import {
  assertNativeStaticContextMatches,
  createNativeStaticContext,
} from "./memory-policy.js";
import { orderReconstructedToolDefinitions } from "./build-run-input.js";
import { CHAT_AGENT_ID, parseChatAgentRecipe } from "./run-recipe.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(resolve(currentDir, file), "utf8");

const SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const MODEL_ID = "deepseek/deepseek-v4-flash-0731";
const metadata = {
  sessionId: SESSION_ID,
  documentIds: [],
  modelId: MODEL_ID,
  reasoningEffort: "max" as const,
  webSearchEnabled: false,
  imageGenerationEnabled: false,
  deepResearchEnabled: false,
  imageGenSettings: null,
};

const toolDefinition: ToolDefinition = {
  name: "search_documents",
  description: "Search the authenticated documents.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

function staticContext() {
  return createNativeStaticContext({
    baseInstructions: "Use only the authenticated context.",
    instructions: ["Keep answers concise."],
    contextBlocks: [{ id: "project", text: "A frozen project context." }],
    toolDefinitions: [toolDefinition],
    model: { contextWindowTokens: 10_000, maxInputTokens: 9_000, maxOutputTokens: 1_000 },
  });
}

function recipeWithContext(context = staticContext()) {
  return parseChatAgentRecipe({
    version: 2,
    agentId: CHAT_AGENT_ID,
    identity: { sessionId: SESSION_ID, userId: USER_ID, projectId: null },
    model: { id: MODEL_ID, reasoningEffort: "max" },
    memoryPolicy: {
      version: 1,
      savePolicy: "turn",
      staticContextTokens: context.staticContextTokens,
      triggerAfterTokens: 5_000,
      retentionRecentTokens: 2_000,
      compactorMaxTokens: 512,
      conflictRetries: 3,
    },
    staticContext: context,
    features: { webSearchEnabled: false, imageGenerationEnabled: false, deepResearchEnabled: false },
    imageGenSettings: null,
    budgets: { maxTurns: 20, deepResearchMaxTurns: 8, deepResearchMaxSearches: 12 },
    documents: { ids: [], catalog: [] },
    instructionFragments: ["Keep answers concise."],
    contextDescriptors: [{ id: "project", text: "A frozen project context." }],
    activeContext: { images: [], snippet: null },
    capabilities: {
      modelAcceptsImage: false,
      webSearchAvailable: false,
      imageGenerationAvailable: false,
      deepResearchAvailable: false,
      profilingEnabled: false,
      context7Requested: false,
      imageModelCapabilities: [],
    },
    promptClientMessageId: null,
    trace: { traceId: "trace-1" },
  });
}

const approvalRequest = parseAgentInteractionRequest({
  id: "interaction-1",
  type: "tool-approval",
  toolName: "web_search",
  toolCallId: "tool-call-1",
  internalCallId: "internal-call-1",
  input: { query: "an approved query" },
});

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
};

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

async function* eventsOf(...events: readonly ChatStreamEvent[]) {
  for (const event of events) yield event;
}

describe("Anvia v1 migration-wide API contracts", () => {
  it("keeps the strict recipe, static surface, and native memory policy in parity", () => {
    const context = staticContext();
    const recipe = recipeWithContext(context);

    expect(JSON.parse(JSON.stringify(recipe))).toEqual(recipe);
    expect(() => parseChatAgentRecipe({ ...recipe, runtime: () => undefined })).toThrow();

    expect(() =>
      assertNativeStaticContextMatches({
        expected: context,
        expectedPolicyStaticContextTokens: recipe.memoryPolicy.staticContextTokens,
        baseInstructions: context.instructions.base,
        instructions: context.instructions.additional,
        contextBlocks: context.context,
        toolDefinitions: context.tools,
        model: context.model,
      }),
    ).not.toThrow();

    expect(() =>
      assertNativeStaticContextMatches({
        expected: context,
        expectedPolicyStaticContextTokens: recipe.memoryPolicy.staticContextTokens,
        baseInstructions: context.instructions.base,
        instructions: context.instructions.additional,
        contextBlocks: context.context,
        toolDefinitions: [{ ...toolDefinition, description: "changed after enqueue" }],
        model: context.model,
      }),
    ).toThrow(/native memory static context mismatch/);
  });

  it("keeps Context7 before the optional view_image helper in the frozen surface", () => {
    const context7Tool: ToolDefinition = {
      name: "resolve-library-id",
      description: "Resolve a library id in Context7.",
      parameters: { type: "object" },
    };
    const viewImageTool: ToolDefinition = {
      name: "view_image",
      description: "Inspect an image.",
      parameters: { type: "object" },
    };
    const ordered = orderReconstructedToolDefinitions({
      toolDefinitions: [toolDefinition, viewImageTool],
      context7ToolDefinitions: [context7Tool],
    });

    expect(ordered.map((tool) => tool.name)).toEqual([
      "search_documents",
      "resolve-library-id",
      "view_image",
    ]);
    const frozen = createNativeStaticContext({
      baseInstructions: "Use only the authenticated context.",
      instructions: ["Keep answers concise."],
      contextBlocks: [],
      toolDefinitions: ordered,
      model: {
        contextWindowTokens: 10_000,
        maxInputTokens: 9_000,
        maxOutputTokens: 1_000,
      },
    });
    expect(() =>
      assertNativeStaticContextMatches({
        expected: frozen,
        expectedPolicyStaticContextTokens: frozen.staticContextTokens,
        baseInstructions: frozen.instructions.base,
        instructions: frozen.instructions.additional,
        contextBlocks: frozen.context,
        toolDefinitions: ordered,
        model: frozen.model,
      }),
    ).not.toThrow();
  });

  it("keeps native compaction as one marker-to-event path", async () => {
    const summary: MemoryCompactionMessage = {
      role: "system",
      content: "The earlier conversation was compacted into this summary.",
      metadata: {
        anvia: { memoryCompaction: { version: 1, compactedMessageCount: 4 } },
      },
    };
    expect(isMemoryCompactionMessage(summary)).toBe(true);
    expect(isMemoryCompactionMessage({ role: "system", content: "summary" } as Message)).toBe(false);

    const compaction = {
      type: "memory_compaction",
      originalMessageCount: 6,
      compactedMessageCount: 4,
      retainedMessageCount: 2,
      originalTokenCount: 200,
      compactedTokenCount: 80,
      retainedTokenCount: 40,
      resultTokenCount: 120,
      attempts: 1,
      usage,
    } as const;
    const stream = await collect(
      createChatClientStream({
        runId: "run-1",
        metadata: { sessionId: "session-1", modelId: MODEL_ID, reasoningEffort: "max" },
        events: eventsOf(compaction as unknown as ChatStreamEvent, {
          type: "response",
          runId: "run-1",
          text: "done",
          output: "done",
          usage,
          messages: [],
        } as unknown as ChatStreamEvent),
      }),
    );
    const nativeEvent = stream.find((event) => event.type === "memory_compaction");
    expect(nativeEvent).toMatchObject(compaction);
    expect(stream.some((event) => event.type === "data" && String(event.name) === "compactionStatus")).toBe(false);
    expect(() => parseClientStreamEvent(nativeEvent!, {
      metadataSchema: ChatMetadataSchema,
      dataSchemas: ChatDataSchemas,
    })).not.toThrow();
  });

  it("accepts only official v1 request and interaction unions", () => {
    const request = {
      type: "messages" as const,
      messages: [{ role: "user" as const, content: "hello" }],
      metadata,
      resume: { streamId: "stream-1", after: 3 },
    };
    expect(parseClientStreamRequest(request)).toMatchObject({
      type: "messages",
      resume: request.resume,
    });
    expect(parseChatClientRequest(request)).toMatchObject({ kind: "resume", cursor: request.resume });

    const response = { type: "tool-approval" as const, approved: true };
    assertAgentInteractionResponse(approvalRequest, response);
    const continuation = parseAgentContinuation({
      version: 1,
      agentId: CHAT_AGENT_ID,
      sourceRunId: "run-1",
      interaction: approvalRequest,
      state: { safe: true },
    });
    expect(continuation.interaction).toEqual(approvalRequest);

    expect(() => parseChatClientRequest({
      ...request,
      promptMessage: { role: "user", content: "legacy" },
      stream: true,
    })).toThrow();
    expect(() => assertAgentInteractionResponse(
      approvalRequest,
      { type: "tool-question", answers: [{ questionId: "x", value: "y" }] },
    )).toThrow(/type does not match/);
  });

  it("does not retain the deleted app compaction engine or a v0 stream bridge", () => {
    const worker = source("run-worker.ts");
    const usageSource = source("context-usage.ts");
    const requestSource = source("client-request.ts");
    const router = source("router.ts");

    expect(() => readFileSync(resolve(currentDir, "compaction.ts"), "utf8")).toThrow();
    expect(worker).not.toMatch(/compactSessionMemory|estimateMessagesTokens|compactionStatus/);
    expect(usageSource).not.toMatch(/compactSessionMemory|compactionStatus|createSummaryMemoryCompactor/);
    expect(requestSource).not.toMatch(/promptMessage|humanInput|ToolApproval|tool_approval_request/);
    expect(router).not.toMatch(/tool_approval_request|clarification_request|createRequest|humanInput/);
    expect(CLIENT_STREAM_PROTOCOL).toBe("anvia.client.v3");
  });

  it("gates the suspended interaction until durable persistence completes", async () => {
    const persisted: string[] = [];
    let release!: () => void;
    const waitForPersistence = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const sourceEvents = eventsOf({
      type: "interaction",
      runId: "run-1",
      interaction: approvalRequest,
      continuation: {
        version: 1,
        agentId: CHAT_AGENT_ID,
        sourceRunId: "run-1",
        interaction: approvalRequest,
        state: {},
      },
    } as unknown as ChatStreamEvent);
    const gated = gateRootInteraction(sourceEvents, async () => {
      await waitForPersistence;
      persisted.push("interaction");
    });
    const iterator = gated[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    expect(persisted).toEqual([]);
    release();
    await expect(pending).resolves.toMatchObject({ value: { type: "interaction" } });
    expect(persisted).toEqual(["interaction"]);
  });
});
