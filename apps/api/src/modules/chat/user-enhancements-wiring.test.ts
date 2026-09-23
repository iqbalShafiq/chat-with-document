import { describe, expect, it, vi } from "vitest";
import { resolveChatAgentRecipe } from "./build-run-input.js";

function baseDependencies(extra: Record<string, unknown> = {}) {
  return {
    prisma: {
      chatSession: { findFirst: vi.fn(async () => ({ projectId: null })) },
      userSkill: { findMany: vi.fn(async () => []) },
      userMcpServer: { findMany: vi.fn(async () => []) },
    } as never,
    findActiveModel: async () => ({
      reasoningEfforts: [],
      inputModalities: ["text"],
      contextWindowTokens: 1_050_000,
      maxInputTokens: null,
      maxOutputTokens: null,
    }),
    resolveActiveDocuments: async () => [],
    listActiveImages: async () => [],
    getActiveSnippet: async () => null,
    webSearchConfig: () => null,
    imageGenerationConfig: () => null,
    profilingEnabled: () => false,
    deepResearchLimits: () => ({ maxTurns: 8, maxSearches: 12, maxDurationMs: 360_000 }),
    context7Requested: () => false,
    ...extra,
  };
}

describe("user enhancement tools wiring", () => {
  it("freezes both management tool definitions in the static surface", async () => {
    const recipe = await resolveChatAgentRecipe({
      sessionId: "session-1",
      userId: "user-1",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: null,
      traceId: "trace-1",
      consumeSingleUseContext: false,
      dependencies: baseDependencies(),
    });
    const names = recipe.staticContext.tools.map((tool) => tool.name);
    expect(names).toContain("manage_user_skills");
    expect(names).toContain("manage_user_mcp_servers");
  });
});
