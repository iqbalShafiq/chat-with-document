import { describe, expect, it } from "vitest";
import type { UIMessage, UIMessagePart } from "@anvia/react";
import {
  collectGeneratedImages,
  collectGeneratedImagesFromMessages,
  isImageToolName,
} from "./generated-images";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

function toolPart(
  toolName: string,
  output: unknown,
  state: ToolPart["state"] = "output-available",
): ToolPart {
  return {
    id: `part-${toolName}-${Math.random()}`,
    type: "tool",
    toolName,
    toolCallId: `call-${toolName}-${Math.random()}`,
    state,
    output: output as ToolPart["output"],
  };
}

function message(parts: UIMessagePart[]): UIMessage {
  return { id: `msg-${Math.random()}`, role: "assistant", parts };
}

function imageMeta(overrides: Record<string, unknown> = {}) {
  return {
    imageId: "img-0",
    mediaType: "image/png",
    width: 1024,
    height: 1024,
    modelId: "openai/gpt-5-image-mini",
    prompt: "a red panda",
    index: 0,
    total: 1,
    ...overrides,
  };
}

describe("isImageToolName", () => {
  it("matches generate_image and edit_image only", () => {
    expect(isImageToolName("generate_image")).toBe(true);
    expect(isImageToolName("edit_image")).toBe(true);
    expect(isImageToolName("web_search")).toBe(false);
    expect(isImageToolName("web_fetch")).toBe(false);
    expect(isImageToolName("")).toBe(false);
  });
});

describe("collectGeneratedImages", () => {
  it("maps generate_image output images with index and total", () => {
    const parts = [
      toolPart("generate_image", {
        images: [imageMeta({ imageId: "img-1" })],
      }),
    ];

    expect(collectGeneratedImages(parts)).toEqual([imageMeta({ imageId: "img-1" })]);
  });

  it("parses output that arrives as a JSON string (streaming shape)", () => {
    const parts = [
      toolPart(
        "generate_image",
        JSON.stringify({
          images: [imageMeta({ imageId: "img-2", mediaType: "image/webp" })],
        }),
      ),
    ];

    expect(collectGeneratedImages(parts)).toEqual([
      imageMeta({ imageId: "img-2", mediaType: "image/webp" }),
    ]);
  });

  it("flattens multi-image results preserving per-image index and total", () => {
    const parts = [
      toolPart("generate_image", {
        images: [
          imageMeta({ imageId: "img-3a", index: 0, total: 2 }),
          imageMeta({ imageId: "img-3b", index: 1, total: 2 }),
        ],
      }),
    ];

    expect(collectGeneratedImages(parts)).toEqual([
      imageMeta({ imageId: "img-3a", index: 0, total: 2 }),
      imageMeta({ imageId: "img-3b", index: 1, total: 2 }),
    ]);
  });

  it("dedupes by imageId with first appearance winning", () => {
    const parts = [
      toolPart(
        "generate_image",
        { images: [imageMeta({ imageId: "img-4", modelId: "m1" })] },
      ),
      toolPart(
        "generate_image",
        { images: [imageMeta({ imageId: "img-4", modelId: "m2" })] },
      ),
    ];

    expect(collectGeneratedImages(parts)).toEqual([
      imageMeta({ imageId: "img-4", modelId: "m1" }),
    ]);
  });

  it("ignores parts without output-available state", () => {
    const parts = [
      toolPart("generate_image", { images: [] }, "input-streaming"),
      toolPart("generate_image", { images: [] }, "input-available"),
      toolPart("generate_image", { images: [] }, "error"),
    ];

    expect(collectGeneratedImages(parts)).toEqual([]);
  });

  it("collects edit_image results too", () => {
    const parts = [
      toolPart("edit_image", {
        images: [imageMeta({ imageId: "img-5", prompt: "edited" })],
      }),
    ];

    expect(collectGeneratedImages(parts)).toEqual([
      imageMeta({ imageId: "img-5", prompt: "edited" }),
    ]);
  });

  it("skips non-image tools and entries without an imageId", () => {
    const parts = [
      toolPart("web_search", {
        results: [{ url: "https://example.com", title: "t" }],
      }),
      toolPart("generate_image", {
        images: [
          { mediaType: "image/png", width: 1, height: 1, modelId: "m" },
          imageMeta({ imageId: "img-6" }),
        ],
      }),
    ];

    expect(collectGeneratedImages(parts)).toEqual([imageMeta({ imageId: "img-6" })]);
  });
});

describe("collectGeneratedImagesFromMessages", () => {
  it("flattens tool parts across messages", () => {
    const messages = [
      message([toolPart("web_search", { results: [] })]),
      message([toolPart("generate_image", { images: [imageMeta({ imageId: "a" })] })]),
      message([toolPart("edit_image", { images: [imageMeta({ imageId: "b" })] })]),
    ];

    expect(collectGeneratedImagesFromMessages(messages)).toEqual([
      imageMeta({ imageId: "a" }),
      imageMeta({ imageId: "b" }),
    ]);
  });
});
