import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reconstructChatRunInput,
  resolveChatAgentRecipe,
} from "./build-run-input.js";
import { CHAT_AGENT_ID, parseChatAgentRecipe } from "./run-recipe.js";
import {
  BASE_INSTRUCTIONS,
  CLARIFICATION_TOOL_DEFINITIONS,
  DATA_ANALYSIS_TOOL_DEFINITIONS,
  DEEP_RESEARCH_TOOL_DEFINITIONS,
  DOCUMENT_TOOL_DEFINITIONS,
  IMAGE_GENERATION_TOOL_DEFINITIONS,
  PROFILE_TOOL_DEFINITIONS,
  TABULAR_TOOL_DEFINITIONS,
  WEB_SEARCH_TOOL_DEFINITIONS,
} from "@assingment/agent";
import { createNativeStaticContext } from "./memory-policy.js";
import { formatContextSnippetBlock } from "./context-snippets.js";
import { VIEW_IMAGE_TOOL_DEFINITIONS } from "./vision-helper.js";

function recipe(overrides: Record<string, unknown> = {}) {
  const value = {
    version: 2,
    agentId: CHAT_AGENT_ID,
    identity: { sessionId: "session-1", userId: "user-1", projectId: null },
    model: { id: "openai/gpt-5.6-luna", reasoningEffort: null },
    memoryPolicy: {
      version: 1,
      savePolicy: "turn",
      staticContextTokens: 0,
      triggerAfterTokens: 700_000,
      retentionRecentTokens: 300_000,
      compactorMaxTokens: 4096,
      conflictRetries: 3,
    },
    staticContext: {
      version: 1,
      instructions: { base: "Base", additional: [] },
      context: [],
      tools: [],
      model: {
        contextWindowTokens: 1_050_000,
        maxInputTokens: null,
        maxOutputTokens: null,
      },
      staticContextTokens: 0,
    },
    features: {
      webSearchEnabled: false,
      imageGenerationEnabled: false,
      deepResearchEnabled: false,
    },
    imageGenSettings: null,
    budgets: { maxTurns: 20, deepResearchMaxTurns: 8, deepResearchMaxSearches: 12 },
    documents: { ids: [], catalog: [] },
    instructionFragments: ["Frozen instruction"],
    contextDescriptors: [{ id: "frozen", text: "Frozen context" }],
    activeContext: { images: [], snippet: null },
    capabilities: {
      modelAcceptsImage: true,
      webSearchAvailable: false,
      imageGenerationAvailable: false,
      deepResearchAvailable: false,
      profilingEnabled: false,
      context7Requested: false,
      imageModelCapabilities: [],
    },
    promptClientMessageId: null,
    trace: { traceId: "trace-1" },
    ...overrides,
  } as any;
  const capabilities = value.capabilities;
  const contextBlocks = [
    ...value.contextDescriptors,
    ...(value.activeContext.images.length > 0
      ? [{
          id: "active_image_context",
          text:
            "Active image context\n" +
            "The user pinned the following images as context for this conversation. " +
            "They take priority over any other images mentioned in the session:\n" +
            value.activeContext.images
              .map((image: any, index: number) =>
                `${index + 1}. ${image.prompt || image.id} (${image.mediaType}) — imageId: ${image.id}`,
              )
              .join("\n"),
        }]
      : []),
    ...(value.activeContext.snippet
      ? [{
          id: "session_context_snippet",
          text: formatContextSnippetBlock(value.activeContext.snippet),
        }]
      : []),
  ];
  const toolDefinitions = [
    ...DATA_ANALYSIS_TOOL_DEFINITIONS,
    ...TABULAR_TOOL_DEFINITIONS,
    ...(value.documents.ids.length > 0 ? DOCUMENT_TOOL_DEFINITIONS : []),
    ...(capabilities.profilingEnabled ? PROFILE_TOOL_DEFINITIONS : []),
    ...(capabilities.webSearchAvailable ? WEB_SEARCH_TOOL_DEFINITIONS : []),
    ...(capabilities.deepResearchAvailable ? DEEP_RESEARCH_TOOL_DEFINITIONS : []),
    ...(capabilities.imageGenerationAvailable ? IMAGE_GENERATION_TOOL_DEFINITIONS : []),
    ...CLARIFICATION_TOOL_DEFINITIONS,
    ...(!capabilities.modelAcceptsImage
      ? [VIEW_IMAGE_TOOL_DEFINITIONS.description]
      : capabilities.webSearchAvailable
        ? [VIEW_IMAGE_TOOL_DEFINITIONS.vision]
        : []),
  ];
  const staticContext = createNativeStaticContext({
    baseInstructions: BASE_INSTRUCTIONS,
    instructions: value.instructionFragments,
    contextBlocks,
    toolDefinitions,
    model: {
      contextWindowTokens: 1_050_000,
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  });
  value.staticContext = staticContext;
  value.memoryPolicy = {
    ...value.memoryPolicy,
    staticContextTokens: staticContext.staticContextTokens,
  };
  return parseChatAgentRecipe(value);
}

describe("run recipe reconstruction capability boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails instead of silently dropping a frozen web capability", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    const frozen = recipe({
      capabilities: {
        modelAcceptsImage: true,
        webSearchAvailable: true,
        imageGenerationAvailable: false,
        deepResearchAvailable: true,
        profilingEnabled: false,
        context7Requested: false,
        imageModelCapabilities: [],
      },
    });

    await expect(reconstructChatRunInput({ recipe: frozen })).rejects.toThrow(
      "frozen web-search capability is unavailable",
    );
  });

  it("fails instead of silently dropping a frozen image capability", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    const frozen = recipe({
      capabilities: {
        modelAcceptsImage: true,
        webSearchAvailable: false,
        imageGenerationAvailable: true,
        deepResearchAvailable: false,
        profilingEnabled: false,
        context7Requested: false,
        imageModelCapabilities: [],
      },
    });

    await expect(reconstructChatRunInput({ recipe: frozen })).rejects.toThrow(
      "frozen image-generation capability is unavailable",
    );
  });

  it("requires and reconstructs the frozen image-model capability catalog", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://image-provider.invalid/v1");
    const emptyCatalog = recipe({
      capabilities: {
        modelAcceptsImage: true,
        webSearchAvailable: false,
        imageGenerationAvailable: true,
        deepResearchAvailable: false,
        profilingEnabled: false,
        context7Requested: false,
        imageModelCapabilities: [],
      },
    });
    await expect(reconstructChatRunInput({ recipe: emptyCatalog })).rejects.toThrow(
      "frozen image-generation capability catalog is empty",
    );

    const withCatalog = recipe({
      capabilities: {
        ...emptyCatalog.capabilities,
        imageModelCapabilities: [
          {
            modelId: "openai/gpt-image-1",
            capabilities: { nMax: 2, quality: ["high"] },
          },
        ],
      },
    });
    const reconstructed = await reconstructChatRunInput({
      recipe: withCatalog,
      runtime: {
        createAgent: (() => ({}) as never) as never,
        createCompletionModel: (() => ({}) as never) as never,
        createMemoryStore: () => ({
          load: async () => [],
          append: async () => undefined,
          clear: async () => undefined,
        }) as never,
      },
    });
    expect(reconstructed.imageGenerationAvailable).toBe(true);
  });

  it("reconstructs frozen instructions and context without rediscovering session state", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeAgent = {} as never;
    const fakeMemory = {
      load: async () => [],
      append: async () => undefined,
      clear: async () => undefined,
    } as never;
    const frozen = recipe({
      instructionFragments: ["Frozen instruction", "Frozen policy"],
      contextDescriptors: [{ id: "frozen", text: "Frozen profile" }],
      activeContext: {
        images: [
          {
            id: "image-frozen",
            r2Key: "images/user-1/image-frozen",
            mediaType: "image/png",
            prompt: "Frozen image",
          },
        ],
        snippet: { id: "snippet-frozen", text: "Frozen excerpt", sourceRole: "user" },
      },
    });

    const reconstructed = await reconstructChatRunInput({
      recipe: frozen,
      runtime: {
        createAgent: ((options: Record<string, unknown>) => {
          capturedOptions = options;
          return fakeAgent;
        }) as never,
        createCompletionModel: (() => ({}) as never) as never,
        createMemoryStore: () => fakeMemory,
      },
    });

    expect(capturedOptions).toBeDefined();
    expect(
      reconstructed.instructions.filter(
        (instruction) => instruction === "Frozen instruction",
      ),
    ).toHaveLength(1);
    expect(
      reconstructed.instructions.filter(
        (instruction) => instruction === "Frozen policy",
      ),
    ).toHaveLength(1);
    expect(capturedOptions?.additionalContext).toEqual([
      { id: "frozen", text: "Frozen profile" },
      expect.objectContaining({ id: "active_image_context" }),
      expect.objectContaining({ id: "session_context_snippet" }),
    ]);
    expect(capturedOptions?.memory).toEqual(
      expect.objectContaining({
        savePolicy: "turn",
        compaction: expect.objectContaining({
          trigger: { afterTokens: frozen.memoryPolicy.triggerAfterTokens },
          retention: { recentTokens: frozen.memoryPolicy.retentionRecentTokens },
          conflictRetries: { maxAttempts: frozen.memoryPolicy.conflictRetries },
          compactor: expect.any(Function),
        }),
      }),
    );
    expect(reconstructed.activeContextImages[0]?.id).toBe("image-frozen");
    expect(reconstructed.activeContextSnippet?.id).toBe("snippet-frozen");
  });

  it("resolver snapshots authenticated documents, profile, and active context", async () => {
    const model = {
      reasoningEfforts: ["medium"],
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_050_000,
      maxInputTokens: null,
      maxOutputTokens: null,
    };
    const documents = [
      { id: "doc-frozen", filename: "brief.pdf", firstPageSummary: "Frozen brief" },
    ];
    const images = [
      {
        id: "image-frozen",
        userId: "user-1",
        sessionId: "session-1",
        r2Key: "images/user-1/image-frozen",
        mediaType: "image/png",
        prompt: "Frozen image",
      },
    ];
    const snippet = {
      id: "snippet-frozen",
      userId: "user-1",
      sessionId: "session-1",
      text: "Frozen excerpt",
      sourceRole: "user" as const,
    };
    let context7Reads = 0;
    const fakePrisma = {
      chatSession: {
        findFirst: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      },
      project: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ name: "Frozen project", description: "Frozen description" }),
      },
    };

    const resolved = await resolveChatAgentRecipe({
      sessionId: "session-1",
      userId: "user-1",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "medium",
      traceId: "trace-1",
      consumeSingleUseContext: false,
      dependencies: {
        prisma: fakePrisma as never,
        findActiveModel: async () => model,
        resolveActiveDocuments: async () => documents,
        listActiveImages: async () => images,
        getActiveSnippet: async () => snippet,
        webSearchConfig: () => null,
        imageGenerationConfig: () => null,
        profilingEnabled: () => false,
        deepResearchLimits: () => ({ maxTurns: 8, maxSearches: 12 }),
        context7Requested: () => {
          context7Reads += 1;
          return false;
        },
      },
    });

    documents[0]!.filename = "mutated-after-resolve.pdf";
    images[0]!.prompt = "mutated after resolve";
    snippet.text = "mutated after resolve";

    expect(resolved.documents).toEqual({
      ids: ["doc-frozen"],
      catalog: [
        {
          id: "doc-frozen",
          filename: "brief.pdf",
          firstPageSummary: "Frozen brief",
        },
      ],
    });
    expect(resolved.activeContext.images[0]?.prompt).toBe("Frozen image");
    expect(resolved.activeContext.snippet?.text).toBe("Frozen excerpt");
    expect(context7Reads).toBe(1);
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
  });
});
