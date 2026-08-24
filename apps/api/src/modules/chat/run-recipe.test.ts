import { describe, expect, it } from "vitest";
import {
  CHAT_AGENT_ID,
  createChatAgentRecipe,
  parseChatAgentRecipe,
  projectContextSnippet,
  projectGeneratedImage,
} from "./run-recipe.js";

const fixture = {
  version: 2 as const,
  agentId: CHAT_AGENT_ID,
  identity: {
    sessionId: "session-1",
    userId: "user-1",
    projectId: "project-1",
  },
  model: { id: "openai/gpt-5.6-luna", reasoningEffort: "high" as const },
  memoryPolicy: {
    version: 1 as const,
    savePolicy: "turn" as const,
    staticContextTokens: 0,
    triggerAfterTokens: 700_000,
    retentionRecentTokens: 300_000,
    compactorMaxTokens: 4096,
    conflictRetries: 3,
  },
  staticContext: {
    version: 1 as const,
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
    webSearchEnabled: true,
    imageGenerationEnabled: false,
    deepResearchEnabled: true,
  },
  imageGenSettings: {
    modelId: "openai/gpt-image-1",
    aspectRatio: "1:1",
    quality: "high",
    background: "transparent",
    n: 2,
  },
  budgets: {
    maxTurns: 20,
    deepResearchMaxTurns: 8,
    deepResearchMaxSearches: 12,
  },
  documents: {
    ids: ["doc-1"],
    catalog: [
      {
        id: "doc-1",
        filename: "brief.pdf",
        firstPageSummary: "A project brief.",
      },
    ],
  },
  instructionFragments: ["Use the frozen document catalog."],
  contextDescriptors: [{ id: "project", text: "Project context." }],
  activeContext: {
    images: [
      {
        id: "image-1",
        r2Key: "images/user-1/image-1",
        mediaType: "image/png",
        prompt: "A chart",
      },
    ],
    snippet: { id: "snippet-1", text: "Pinned text", sourceRole: "user" as const },
  },
  capabilities: {
    modelAcceptsImage: true,
    webSearchAvailable: true,
    imageGenerationAvailable: false,
    deepResearchAvailable: true,
    profilingEnabled: true,
    context7Requested: true,
    imageModelCapabilities: [],
  },
  promptClientMessageId: "client-message-1",
  trace: { traceId: "trace-1", observationId: "observation-1" },
};

describe("ChatAgentRecipe", () => {
  it("accepts a complete recipe and preserves it through JSON round-trip", () => {
    const parsed = parseChatAgentRecipe(fixture);

    expect(parsed).toEqual(JSON.parse(JSON.stringify(fixture)));
    expect(parsed.agentId).toBe("chat-agent");
  });

  it("creates deterministic recipe output from the same resolved inputs", () => {
    const first = createChatAgentRecipe(fixture);
    const second = createChatAgentRecipe({ ...fixture });

    expect(first).toEqual(second);
    expect(first).toEqual(fixture);
  });

  it("rejects invalid identity, version, agent id, unknown fields, and secrets", () => {
    expect(() => parseChatAgentRecipe({ ...fixture, version: 3 })).toThrow();
    expect(() => parseChatAgentRecipe({ ...fixture, agentId: "my-agent" })).toThrow();
    expect(() =>
      parseChatAgentRecipe({ ...fixture, apiKey: "secret" }),
    ).toThrow();
    expect(() =>
      parseChatAgentRecipe({
        ...fixture,
        identity: { ...fixture.identity, secret: "secret" },
      }),
    ).toThrow();
  });

  it("rejects non-JSON runtime values and binary image data", () => {
    expect(() =>
      parseChatAgentRecipe({
        ...fixture,
        activeContext: {
          ...fixture.activeContext,
          images: [{ ...fixture.activeContext.images[0], bytes: new Uint8Array([1]) }],
        },
      }),
    ).toThrow();
    expect(() =>
      parseChatAgentRecipe({ ...fixture, trace: { traceId: new Date() } }),
    ).toThrow();
    expect(() =>
      parseChatAgentRecipe({ ...fixture, runtime: () => undefined }),
    ).toThrow();
  });

  it("projects image and snippet records without dates or binary fields", () => {
    expect(
      projectGeneratedImage({
        id: "image-1",
        userId: "user-1",
        projectId: null,
        sessionId: "session-1",
        r2Key: "images/user-1/image-1",
        mediaType: "image/png",
        width: 100,
        height: 100,
        modelId: "model",
        prompt: "A chart",
        nOfTotal: null,
        source: "generated",
        sourceUrl: null,
        createdAt: new Date(),
      }),
    ).toEqual({
      id: "image-1",
      r2Key: "images/user-1/image-1",
      mediaType: "image/png",
      prompt: "A chart",
    });

    expect(
      projectContextSnippet({
        id: "snippet-1",
        userId: "user-1",
        sessionId: "session-1",
        text: "Pinned text",
        sourceRole: "assistant",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toEqual({
      id: "snippet-1",
      text: "Pinned text",
      sourceRole: "assistant",
    });
  });
});
