import { describe, expect, it, vi } from "vitest";
import type {
  GeneratedImage,
  ImageGenerationModel,
} from "@anvia/core/image-generation";
import {
  aspectRatioToSize,
  buildImageGenerationInstruction,
  createImageGenerationTools,
  IMAGE_GENERATION_INSTRUCTION,
  resolveImageRequestParams,
  type GeneratedImageRecord,
  type GenerateImageResult,
  type ImageGenerationToolScope,
} from "./image-generation.js";

const DEFAULT_MODEL = "test-model";

type ApprovalPolicy = {
  when(ctx: { args: Record<string, unknown> }): boolean | Promise<boolean>;
  reason(ctx: { args: Record<string, unknown> }): string | Promise<string>;
};

function image(byte: number, mediaType = "image/png"): GeneratedImage {
  return { data: new Uint8Array([byte]), mediaType };
}

function response(...images: GeneratedImage[]) {
  const first = images[0]!;
  return {
    image: first.data,
    images,
    ...(first.mediaType ? { mediaType: first.mediaType } : {}),
    rawResponse: {},
  };
}

function record(
  id: string,
  mediaType = "image/png",
  prompt = "a red fox",
): GeneratedImageRecord {
  return {
    id,
    mediaType,
    width: 1024,
    height: 1024,
    modelId: DEFAULT_MODEL,
    prompt,
  };
}

function makeScope(
  overrides: Partial<ImageGenerationToolScope> = {},
): {
  scope: ImageGenerationToolScope;
  imageGeneration: ReturnType<typeof vi.fn>;
  saveGeneratedImage: ReturnType<typeof vi.fn>;
} {
  const imageGeneration = vi.fn();
  const saveGeneratedImage = vi.fn();
  const model =
    overrides.model ??
    ({
      imageGeneration,
      defaultModel: DEFAULT_MODEL,
    } as unknown as ImageGenerationModel<unknown, string>);
  const scope: ImageGenerationToolScope = {
    model,
    store: { saveGeneratedImage },
    enabled: true,
    hasGrant: () => false,
    takeToolOverride: () => null,
    userId: "user-1",
    sessionId: "session-1",
    projectId: "project-1",
    resolveReference: vi.fn(async () => null),
    capabilities: () => null,
    ...overrides,
  };
  const usedImageGeneration = (
    model as { imageGeneration: ReturnType<typeof vi.fn> }
  ).imageGeneration;
  return { scope, imageGeneration: usedImageGeneration, saveGeneratedImage };
}

describe("createImageGenerationTools", () => {
  it("returns generate_image and edit_image in order", () => {
    const { scope } = makeScope();
    const tools = createImageGenerationTools(scope);
    expect(tools.map((tool) => tool.name)).toEqual([
      "generate_image",
      "edit_image",
    ]);
  });

  describe("approval policy", () => {
    it("requires approval when generation is disabled and no grant exists", async () => {
      const { scope } = makeScope({ enabled: false });
      const tools = createImageGenerationTools(scope);
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(await approval.when({ args: { prompt: "a red fox" } })).toBe(true);
    });

    it("does not require approval when generation is enabled", async () => {
      const { scope } = makeScope({ enabled: true });
      const tools = createImageGenerationTools(scope);
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(await approval.when({ args: { prompt: "a red fox" } })).toBe(false);
    });

    it("does not require approval when a grant exists for the tool", async () => {
      const { scope } = makeScope({
        enabled: false,
        hasGrant: (name) => name === "generate_image",
      });
      const tools = createImageGenerationTools(scope);
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(await approval.when({ args: { prompt: "a red fox" } })).toBe(false);
    });

    it("requires approval for edit_image even when only generate_image is granted", async () => {
      const { scope } = makeScope({
        enabled: false,
        hasGrant: (name) => name === "generate_image",
      });
      const tools = createImageGenerationTools(scope);
      const approval = tools[1]!.approval as ApprovalPolicy;
      expect(
        await approval.when({ args: { prompt: "a red fox", referenceImageId: "img-1" } }),
      ).toBe(true);
    });

    it("fails safe to approval when hasGrant rejects", async () => {
      const { scope } = makeScope({
        enabled: false,
        hasGrant: () => Promise.reject(new Error("redis down")),
      });
      const tools = createImageGenerationTools(scope);
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(await approval.when({ args: { prompt: "a red fox" } })).toBe(true);
    });

    it("does not require approval when hasGrant resolves true", async () => {
      const { scope } = makeScope({
        enabled: false,
        hasGrant: async (name) => name === "generate_image",
      });
      const tools = createImageGenerationTools(scope);
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(await approval.when({ args: { prompt: "a red fox" } })).toBe(false);
    });

    it("justifies approval with the prompt", () => {
      const { scope } = makeScope({ enabled: false });
      const tools = createImageGenerationTools(scope);
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(approval.reason({ args: { prompt: "a red fox" } })).toBe(
        'The agent wants to generate an image: "a red fox"',
      );
    });
  });

  describe("generate_image", () => {
    it("applies a tool override over the args", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope({
        takeToolOverride: () => ({ prompt: "override prompt" }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      saveGeneratedImage.mockResolvedValue(record("rec-1", "image/png", "override prompt"));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "original prompt" });

      expect(imageGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "override prompt" }),
      );
      expect(saveGeneratedImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "override prompt" }),
      );
    });

    it("uses the original args when takeToolOverride rejects", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope({
        takeToolOverride: () => Promise.reject(new Error("redis down")),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      saveGeneratedImage.mockResolvedValue(record("rec-1"));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      expect(imageGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "a red fox" }),
      );
      expect(saveGeneratedImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "a red fox" }),
      );
    });

    it("caps an oversized override n to MAX_IMAGES when capabilities are unknown", async () => {
      const { scope, imageGeneration } = makeScope({
        takeToolOverride: () => ({ n: 100 }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      expect(imageGeneration.mock.calls[0]![0].additionalParams.n).toBe(4);
    });

    it("caps an oversized override n to the capability nMax", async () => {
      const { scope, imageGeneration } = makeScope({
        takeToolOverride: () => ({ n: 100 }),
        capabilities: () => ({ nMax: 1 }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      expect(imageGeneration.mock.calls[0]![0].additionalParams.n).toBe(1);
    });

    it("coerces a string override n safely", async () => {
      const { scope, imageGeneration } = makeScope({
        takeToolOverride: () => ({ n: "5" }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams.n).toBe(4);
      expect(Number.isInteger(request.additionalParams.n)).toBe(true);
    });

    it("drops unknown override keys before they reach the wire", async () => {
      const { scope, imageGeneration } = makeScope({
        takeToolOverride: () => ({ provider: { type: "openrouter" }, n: 2 }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: DEFAULT_MODEL,
        n: 2,
        size: "1024x1024",
      });
    });

    it("rejects an oversized override prompt in favor of the validated args", async () => {
      const { scope, imageGeneration } = makeScope({
        takeToolOverride: () => ({ prompt: "x".repeat(4001) }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      expect(imageGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "a red fox" }),
      );
    });

    it("omits the model param when no model id resolves", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope({
        model: {
          imageGeneration: vi.fn(),
          defaultModel: undefined,
        } as unknown as ImageGenerationModel<unknown, string>,
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      saveGeneratedImage.mockResolvedValue(record("rec-1"));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({ size: "1024x1024" });
      expect(saveGeneratedImage).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "" }),
      );
    });

    it("sends the provider default model when nothing overrides it", async () => {
      const { scope, imageGeneration } = makeScope();
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: DEFAULT_MODEL,
        size: "1024x1024",
      });
    });

    it("sends an explicit modelId arg to the wire request", async () => {
      const { scope, imageGeneration } = makeScope();
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox", modelId: "explicit-model" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: "explicit-model",
        size: "1024x1024",
      });
    });

    it("caps n to the capability nMax", async () => {
      const { scope, imageGeneration } = makeScope({
        capabilities: () => ({ nMax: 1 }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox", n: 5 });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: DEFAULT_MODEL,
        n: 1,
        size: "1024x1024",
      });
    });

    it("drops a background not supported by the capability", async () => {
      const { scope, imageGeneration } = makeScope({
        capabilities: () => ({ nMax: 1 }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox", background: "transparent" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: DEFAULT_MODEL,
        size: "1024x1024",
      });
    });

    it("drops a quality not in the capability list", async () => {
      const { scope, imageGeneration } = makeScope({
        capabilities: () => ({ nMax: 1, quality: ["medium"] }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox", quality: "high" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: DEFAULT_MODEL,
        size: "1024x1024",
      });
    });

    it("keeps a background listed in the capability and forces png output", async () => {
      const { scope, imageGeneration } = makeScope({
        capabilities: () => ({ nMax: 1, background: ["transparent"] }),
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox", background: "transparent" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: DEFAULT_MODEL,
        background: "transparent",
        output_format: "png",
        size: "1024x1024",
      });
    });

    it("saves and reports every image with nOfTotal and never leaks base64", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope();
      imageGeneration.mockResolvedValue(
        response(image(1, "image/png"), image(2, "image/jpeg")),
      );
      saveGeneratedImage
        .mockResolvedValueOnce(record("rec-1", "image/png"))
        .mockResolvedValueOnce(record("rec-2", "image/jpeg"));
      const tools = createImageGenerationTools(scope);

      const output = (await tools[0]!.call({
        prompt: "a red fox",
      })) as GenerateImageResult;

      expect(saveGeneratedImage).toHaveBeenCalledTimes(2);
      expect(saveGeneratedImage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ nOfTotal: "1 of 2" }),
      );
      expect(saveGeneratedImage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ nOfTotal: "2 of 2" }),
      );
      expect(output.images).toHaveLength(2);
      expect(output.images[0]).toEqual({
        imageId: "rec-1",
        mediaType: "image/png",
        width: 1024,
        height: 1024,
        modelId: DEFAULT_MODEL,
        prompt: "a red fox",
        index: 0,
        total: 2,
      });
      expect(output.images[1]).toEqual({
        imageId: "rec-2",
        mediaType: "image/jpeg",
        width: 1024,
        height: 1024,
        modelId: DEFAULT_MODEL,
        prompt: "a red fox",
        index: 1,
        total: 2,
      });
      expect(JSON.stringify(output)).not.toContain("base64");
      expect(output.error).toBeUndefined();
      expect(output.errors).toBeUndefined();
    });

    it("omits nOfTotal when only one image is generated", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope();
      imageGeneration.mockResolvedValue(response(image(1)));
      saveGeneratedImage.mockResolvedValue(record("rec-1"));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      expect(saveGeneratedImage).toHaveBeenCalledWith(
        expect.not.objectContaining({ nOfTotal: expect.anything() }),
      );
    });

    it("returns partial results with errors when saving an image fails", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope();
      imageGeneration.mockResolvedValue(response(image(1), image(2)));
      saveGeneratedImage
        .mockResolvedValueOnce(record("rec-1"))
        .mockRejectedValueOnce(new Error("storage down"));
      const tools = createImageGenerationTools(scope);

      const output = (await tools[0]!.call({
        prompt: "a red fox",
      })) as GenerateImageResult;

      expect(output.images).toHaveLength(1);
      expect(output.images[0]!.imageId).toBe("rec-1");
      expect(output.errors).toEqual(["storage down"]);
    });

    it("returns a bounded error when the model call fails", async () => {
      const { scope, imageGeneration } = makeScope();
      imageGeneration.mockRejectedValue(
        new Error("Image generation rate limit exceeded; try again later"),
      );
      const tools = createImageGenerationTools(scope);

      const output = (await tools[0]!.call({
        prompt: "a red fox",
      })) as GenerateImageResult;

      expect(output.images).toEqual([]);
      expect(output.error).toBe(
        "Image generation rate limit exceeded; try again later",
      );
    });

    it("uses default settings when args omit them", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope({
        defaultSettings: { modelId: "default-model", aspectRatio: "16:9" },
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      saveGeneratedImage.mockResolvedValue(record("rec-1"));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.width).toBe(1344);
      expect(request.height).toBe(768);
      expect(request.additionalParams).toEqual({
        model: "default-model",
        size: "1344x768",
      });
      expect(saveGeneratedImage).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "default-model" }),
      );
    });

    it("prefers explicit args over default settings", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope({
        defaultSettings: { modelId: "default-model", aspectRatio: "16:9" },
      });
      imageGeneration.mockResolvedValue(response(image(1)));
      saveGeneratedImage.mockResolvedValue(record("rec-1"));
      const tools = createImageGenerationTools(scope);

      await tools[0]!.call({ prompt: "a red fox", aspectRatio: "4:3" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.width).toBe(1152);
      expect(request.height).toBe(864);
      expect(saveGeneratedImage).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "default-model" }),
      );
    });
  });

  describe("edit_image", () => {
    it("passes the reference image as an input_references data URL", async () => {
      const { scope, imageGeneration, saveGeneratedImage } = makeScope({
        resolveReference: async () => ({
          mediaType: "image/png",
          buffer: new Uint8Array([1, 2, 3]),
        }),
      });
      imageGeneration.mockResolvedValue(response(image(9)));
      saveGeneratedImage.mockResolvedValue(record("rec-1"));
      const tools = createImageGenerationTools(scope);

      await tools[1]!.call({ prompt: "make it red", referenceImageId: "img-1" });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).toEqual({
        model: DEFAULT_MODEL,
        input_references: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AQID" },
          },
        ],
        size: "1024x1024",
      });
      expect(saveGeneratedImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "make it red" }),
      );
    });

    it("returns an error when the reference image is missing", async () => {
      const { scope, imageGeneration } = makeScope({
        resolveReference: async () => null,
      });
      const tools = createImageGenerationTools(scope);

      const output = (await tools[1]!.call({
        prompt: "make it red",
        referenceImageId: "missing",
      })) as GenerateImageResult;

      expect(output.images).toEqual([]);
      expect(output.error).toBe("Reference image not found");
      expect(imageGeneration).not.toHaveBeenCalled();
    });

    it("returns an error when the reference image exceeds maxBytes", async () => {
      const { scope, imageGeneration } = makeScope({
        maxBytes: 2,
        resolveReference: async () => ({
          mediaType: "image/png",
          buffer: new Uint8Array([1, 2, 3]),
        }),
      });
      const tools = createImageGenerationTools(scope);

      const output = (await tools[1]!.call({
        prompt: "make it red",
        referenceImageId: "img-1",
      })) as GenerateImageResult;

      expect(output.images).toEqual([]);
      expect(output.error).toBe("Reference image too large");
      expect(imageGeneration).not.toHaveBeenCalled();
    });

    it("applies a tool override for edits", async () => {
      const { scope, imageGeneration } = makeScope({
        takeToolOverride: () => ({ prompt: "override edit" }),
        resolveReference: async () => ({
          mediaType: "image/png",
          buffer: new Uint8Array([1]),
        }),
      });
      imageGeneration.mockResolvedValue(response(image(9)));
      const tools = createImageGenerationTools(scope);

      await tools[1]!.call({
        prompt: "original edit",
        referenceImageId: "img-1",
      });

      expect(imageGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "override edit" }),
      );
    });

    it("does not apply an n override since the edit schema has no n", async () => {
      const { scope, imageGeneration } = makeScope({
        takeToolOverride: () => ({ n: 3 }),
        resolveReference: async () => ({
          mediaType: "image/png",
          buffer: new Uint8Array([1]),
        }),
      });
      imageGeneration.mockResolvedValue(response(image(9)));
      const tools = createImageGenerationTools(scope);

      await tools[1]!.call({
        prompt: "make it red",
        referenceImageId: "img-1",
      });

      const request = imageGeneration.mock.calls[0]![0];
      expect(request.additionalParams).not.toHaveProperty("n");
    });
  });
});

describe("aspectRatioToSize", () => {
  it("returns the mapped dimensions for known ratios", () => {
    expect(aspectRatioToSize("1:1")).toEqual({ width: 1024, height: 1024 });
    expect(aspectRatioToSize("16:9")).toEqual({ width: 1344, height: 768 });
    expect(aspectRatioToSize("9:16")).toEqual({ width: 768, height: 1344 });
    expect(aspectRatioToSize("auto")).toEqual({ width: 1024, height: 1024 });
  });

  it("falls back to auto dimensions for unknown or missing ratios", () => {
    expect(aspectRatioToSize("2:1")).toEqual({ width: 1024, height: 1024 });
    expect(aspectRatioToSize(undefined)).toEqual({ width: 1024, height: 1024 });
  });
});

describe("resolveImageRequestParams", () => {
  it("picks the exact accepted size for OpenAI-style models", () => {
    const capability = {
      nMax: 1,
      sizes: ["1024x1024", "1024x1536", "1536x1024", "auto"],
    };
    expect(resolveImageRequestParams("1:1", capability)).toEqual({
      size: "1024x1024",
    });
    expect(resolveImageRequestParams("3:2", capability)).toEqual({
      size: "1536x1024",
    });
    expect(resolveImageRequestParams("2:3", capability)).toEqual({
      size: "1024x1536",
    });
  });

  it("falls back to auto when the ratio has no accepted pixel size", () => {
    const capability = {
      nMax: 1,
      sizes: ["1024x1024", "1024x1536", "1536x1024", "auto"],
    };
    // 16:9 has no matching size in the OpenAI list → auto (never an
    // unsupported pixel size that would 400 the request).
    expect(resolveImageRequestParams("16:9", capability)).toEqual({
      size: "auto",
    });
  });

  it("uses aspect_ratio + resolution for Gemini/Grok-style models (no size)", () => {
    const capability = { nMax: 1, resolutions: ["1K"] };
    expect(resolveImageRequestParams("9:16", capability)).toEqual({
      aspectRatio: "9:16",
      resolution: "1K",
    });
  });

  it("falls back to the canonical pixel size when capabilities are unknown", () => {
    expect(resolveImageRequestParams("16:9", null)).toEqual({
      size: "1344x768",
    });
    expect(resolveImageRequestParams(undefined, null)).toEqual({
      size: "1024x1024",
    });
  });

  it("never emits an unsupported size for any model family", () => {
    const openai = { nMax: 1, sizes: ["1024x1024", "1024x1536", "1536x1024", "auto"] };
    const gemini = { nMax: 1, resolutions: ["1K"] };
    for (const ratio of ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "9:19.5", "19.5:9", "auto"]) {
      const o = resolveImageRequestParams(ratio, openai);
      if (o.size) {
        expect(openai.sizes).toContain(o.size);
      } else {
        expect(o.aspectRatio).toBe(ratio);
        expect(o.resolution).toBe("1K");
        expect(o.size).toBeUndefined();
      }
    }
    const g = resolveImageRequestParams("1:1", gemini);
    expect(g.size).toBeUndefined();
    expect(g.aspectRatio).toBe("1:1");
  });
});

describe("IMAGE_GENERATION_INSTRUCTION", () => {
  it("guides web-first research, session defaults, clarification, ids, and approval", () => {
    expect(IMAGE_GENERATION_INSTRUCTION).toContain("web_search");
    expect(IMAGE_GENERATION_INSTRUCTION).toContain("session defaults");
    expect(IMAGE_GENERATION_INSTRUCTION).toContain("request_clarification");
    expect(IMAGE_GENERATION_INSTRUCTION).toContain("image ids");
    expect(IMAGE_GENERATION_INSTRUCTION).toContain("approval");
  });
});

describe("buildImageGenerationInstruction", () => {
  it("keeps the web_search-first sentence when web search is available", () => {
    const instruction = buildImageGenerationInstruction({
      webSearchAvailable: true,
    });
    expect(instruction).toContain("web_search first");
    expect(instruction).toContain("session defaults");
    expect(instruction).toContain("request_clarification");
    expect(instruction).toContain("image ids");
    expect(instruction).toContain("approval");
  });

  it("omits the web_search-first sentence when web search is unavailable", () => {
    const instruction = buildImageGenerationInstruction({
      webSearchAvailable: false,
    });
    expect(instruction).not.toContain("web_search");
    expect(instruction).toContain("session defaults");
    expect(instruction).toContain("request_clarification");
    expect(instruction).toContain("image ids");
    expect(instruction).toContain("approval");
  });
});
