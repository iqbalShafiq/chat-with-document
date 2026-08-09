import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../utils/prisma.js";
import { listModels, MODEL_SELECT } from "./service.js";

vi.mock("../../utils/prisma.js", () => ({
  prisma: {
    chatModel: { findMany: vi.fn(), findFirst: vi.fn() },
    reasoningEffort: { findMany: vi.fn() },
  },
}));

function makeModelRow(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "openai/gpt-5-image-mini",
    label: "GPT-5 Image Mini",
    name: "GPT-5 Image Mini",
    hint: "Fastest • $0.008/img",
    description: "OpenAI image generation",
    iconSvg: "",
    contextWindowTokens: 0,
    maxInputTokens: null,
    maxOutputTokens: null,
    inputPricePerMTokens: null,
    cachedInputPricePerMTokens: null,
    outputPricePerMTokens: null,
    cacheWriteMultiplier: null,
    longPromptThresholdTokens: null,
    longPromptInputMultiplier: null,
    longPromptOutputMultiplier: null,
    outputType: "text",
    inputModalities: null,
    outputModalities: null,
    imageCapabilities: null,
    sortOrder: 0,
    provider: { slug: "openai", name: "OpenAI" },
    reasoningEfforts: [],
    ...overrides,
  };
}

describe("models service", () => {
  it("exposes capability columns on MODEL_SELECT", () => {
    const keys = Object.keys(MODEL_SELECT);
    expect(keys).toContain("outputType");
    expect(keys).toContain("inputModalities");
    expect(keys).toContain("outputModalities");
    expect(keys).toContain("imageCapabilities");
  });
});

describe("listModels", () => {
  beforeEach(() => {
    vi.mocked(prisma.chatModel.findMany).mockClear().mockResolvedValue([]);
    vi.mocked(prisma.reasoningEffort.findMany).mockClear().mockResolvedValue([]);
  });

  it("filters by outputType image when requested", async () => {
    await listModels({ outputType: "image" });

    expect(prisma.chatModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          provider: { isActive: true },
          outputType: "image",
        },
      }),
    );
  });

  it("filters by outputType text when requested", async () => {
    await listModels({ outputType: "text" });

    expect(prisma.chatModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          provider: { isActive: true },
          outputType: "text",
        },
      }),
    );
  });

  it("omits the outputType filter when absent", async () => {
    await listModels();

    const args = vi.mocked(prisma.chatModel.findMany).mock.calls[0]?.[0];
    expect(args).toBeDefined();
    expect(
      (args as { where: Record<string, unknown> }).where,
    ).not.toHaveProperty("outputType");
  });

  it("passes outputType and imageCapabilities through to model info", async () => {
    const imageCapabilities = {
      quality: ["auto", "high"],
      n: { min: 1, max: 10 },
      aspectRatios: ["1:1", "16:9"],
    };
    vi.mocked(prisma.chatModel.findMany).mockResolvedValue(
      [makeModelRow({ outputType: "image", imageCapabilities })] as never,
    );

    const result = await listModels({ outputType: "image" });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      modelId: "openai/gpt-5-image-mini",
      outputType: "image",
      imageCapabilities,
    });
  });
});
