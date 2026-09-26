import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_TOOL_DEFINITIONS,
  BASE_INSTRUCTIONS,
  CHART_TOOL_DEFINITIONS,
  CLARIFICATION_TOOL_DEFINITIONS,
  DERIVED_TOOL_DEFINITIONS,
  REPORT_TOOL_DEFINITIONS,
  SITE_BUILD_TOOL_DEFINITIONS,
  SITE_VIEW_TOOL_DEFINITIONS,
  TABULAR_TOOL_DEFINITIONS,
  USER_MCP_TOOL_DEFINITIONS,
  USER_SKILL_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_DEFINITIONS,
} from "@anreal/agent";
import { createNativeStaticContext } from "./memory-policy.js";
import { CHAT_AGENT_ID, parseChatAgentRecipe } from "./run-recipe.js";
import { DEFAULT_SITE_MODEL } from "../static-sites/service.js";

const BRIEF = {
  siteName: "Kopi Senja",
  audience: "pecinta kopi",
  cta: "Pesan",
  sections: ["hero", "kontak"],
  vibe: "hangat",
};

const f = vi.hoisted(() => {
  const siteModel = { sentinel: "site-model" };
  return {
    parseSiteBrief: vi.fn(async (input: {
      prompt: string;
      modelId: string;
      model: unknown;
    }) => ({
      brief: BRIEF,
      usage: { inputTokens: 1, outputTokens: 1 },
      captured: { model: input.model, modelId: input.modelId, prompt: input.prompt },
    })),
    readActiveSiteTitle: vi.fn(async () => null),
    enqueueSiteBuildFromTool: vi.fn(async () => ({ siteId: "site-1", version: 1 })),
    siteModel,
    siteBuildConfig: vi.fn(() => ({
      model: siteModel,
      modelId: "meta/muse-spark-1.3-contributor",
    })),
  };
});

vi.mock("@anreal/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anreal/agent")>()),
  parseSiteBrief: f.parseSiteBrief,
}));

vi.mock("../static-sites/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../static-sites/service.js")>()),
  readActiveSiteTitle: f.readActiveSiteTitle,
  enqueueSiteBuildFromTool: f.enqueueSiteBuildFromTool,
  siteBuildConfig: f.siteBuildConfig,
}));

import { reconstructChatRunInput } from "./build-run-input.js";

const RECIPE_SESSION = "session-bound";
const RECIPE_USER = "user-bound";
const RECIPE_MODEL = "openai/gpt-5.6-luna";

function boundRecipe() {
  const value = {
    version: 6,
    agentId: CHAT_AGENT_ID,
    identity: { sessionId: RECIPE_SESSION, userId: RECIPE_USER, projectId: null },
    model: { id: RECIPE_MODEL, reasoningEffort: null },
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
    budgets: {
      maxTurns: 20,
      deepResearchMaxTurns: 8,
      deepResearchMaxSearches: 12,
      deepResearchMaxDurationMs: 360_000,
    },
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
  } as any;
  const toolDefinitions = [
    ...TABULAR_TOOL_DEFINITIONS,
    ...CHART_TOOL_DEFINITIONS,
    ...DERIVED_TOOL_DEFINITIONS,
    ...CLARIFICATION_TOOL_DEFINITIONS,
    ...SITE_BUILD_TOOL_DEFINITIONS,
    ...ARTIFACT_TOOL_DEFINITIONS,
    ...SITE_VIEW_TOOL_DEFINITIONS,
    ...REPORT_TOOL_DEFINITIONS,
    ...WORKSPACE_TOOL_DEFINITIONS,
    ...USER_SKILL_TOOL_DEFINITIONS,
    ...USER_MCP_TOOL_DEFINITIONS,
  ];
  const staticContext = createNativeStaticContext({
    baseInstructions: BASE_INSTRUCTIONS,
    instructions: value.instructionFragments,
    contextBlocks: [...value.contextDescriptors],
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

describe("site build recipe identity binding", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("binds recipe session and SITE model into the site tools with empty call-time context", async () => {
    const recipeBoundModel = { sentinel: "recipe-model" };
    const reconstructed = await reconstructChatRunInput({
      recipe: boundRecipe(),
      runtime: {
        createAgent: (() => ({})) as never,
        createCompletionModel: (() => recipeBoundModel) as never,
        createMemoryStore: () =>
          ({
            load: async () => [],
            append: async () => undefined,
            clear: async () => undefined,
          }) as never,
      },
    });

    const propose = reconstructed.tools.find((tool) => tool.name === "propose_site_build");
    const confirm = reconstructed.tools.find((tool) => tool.name === "confirm_site_build");
    expect(propose).toBeDefined();
    expect(confirm).toBeDefined();

    await propose!.call({ prompt: "bikinkan landing kopi" }, {});
    expect(f.parseSiteBrief).toHaveBeenCalledTimes(1);
    const briefInput = vi.mocked(f.parseSiteBrief).mock.calls[0]![0] as Record<string, unknown>;
    expect(briefInput.prompt).toBe("bikinkan landing kopi");
    expect(briefInput.modelId).toBe(DEFAULT_SITE_MODEL);
    expect(briefInput.model).toBe(f.siteModel);
    expect(briefInput.model).not.toBe(recipeBoundModel);
    expect(f.readActiveSiteTitle).toHaveBeenCalledWith(RECIPE_SESSION);

    await confirm!.call({ brief: BRIEF, mode: "new-site", prompt: "bikinkan landing kopi" }, {});
    expect(f.enqueueSiteBuildFromTool).toHaveBeenCalledWith({
      siteId: null,
      sessionId: RECIPE_SESSION,
      userId: RECIPE_USER,
      projectId: null,
      prompt: "bikinkan landing kopi",
      brief: BRIEF,
    });
  });
});
