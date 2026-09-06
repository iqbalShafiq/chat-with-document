import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const streamingModel = {
    provider: "openai",
    modelId: "openai/gpt-5.6-luna",
    streamCompletion: vi.fn(),
  };

  return {
    clientConstructor: vi.fn((_options: unknown) => undefined),
    completionModel: vi.fn((_options: unknown) => streamingModel),
    streamingModel,
  };
});

vi.mock("@anvia/openai", () => ({
  OpenAIClient: class {
    constructor(options: unknown) {
      mocks.clientConstructor(options);
    }

    completionModel(options: unknown) {
      return mocks.completionModel(options);
    }
  },
}));

import * as openaiProvider from "./openai.js";

describe("OpenAI provider", () => {
  beforeEach(() => {
    mocks.clientConstructor.mockClear();
    mocks.completionModel.mockClear();
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "https://openrouter.example/v1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs a Responses streaming model with the Anvia v1 object contract", () => {
    const model = openaiProvider.createCompletionModel(
      "openai/gpt-5.6-terra",
    );

    expect(mocks.clientConstructor).toHaveBeenCalledOnce();
    expect(mocks.clientConstructor).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseUrl: "https://openrouter.example/v1",
    });
    expect(mocks.completionModel).toHaveBeenCalledWith({
      modelId: "openai/gpt-5.6-terra",
      api: "responses",
    });
    expect(model).toBe(mocks.streamingModel);
  });

  it("maps reasoning effort to strict provider options", () => {
    expect(openaiProvider.providerOptionsForReasoning("high")).toEqual({
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(openaiProvider.metaMuseReasoningEffort("xhigh")).toEqual({
      reasoning_effort: "xhigh",
    });
  });

  it("routes Meta Muse models through Chat Completions", () => {
    mocks.completionModel.mockClear();
    openaiProvider.createCompletionModel("meta/muse-spark-1.3-contributor");
    expect(mocks.completionModel).toHaveBeenCalledWith({
      modelId: "meta/muse-spark-1.3-contributor",
      api: "chat",
    });
    mocks.completionModel.mockClear();
    openaiProvider.createCompletionModel("openai/gpt-5.6-luna");
    expect(mocks.completionModel).toHaveBeenCalledWith({
      modelId: "openai/gpt-5.6-luna",
      api: "responses",
    });
  });
});
