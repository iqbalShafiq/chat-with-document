import { describe, expect, it } from "vitest";
import type { UIMessage, UIMessagePart } from "@anvia/react";
import {
  collectGeneratedImages,
  collectGeneratedImagesFromMessages,
  countRunningImageToolPartsFromMessages,
  groupImageToolRuns,
  imageItemsFromToolPart,
  isImageToolName,
  isMessageImageToolName,
  mergeGeneratedImages,
  toGeneratedImageItem,
} from "./generated-images";
import type { GeneratedImageMeta } from "#/lib/api";

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
    source: "generated",
    sourceUrl: null,
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

describe("isMessageImageToolName", () => {
  it("includes view_image alongside the image tools", () => {
    expect(isMessageImageToolName("view_image")).toBe(true);
    expect(isMessageImageToolName("generate_image")).toBe(true);
    expect(isMessageImageToolName("edit_image")).toBe(true);
    expect(isMessageImageToolName("web_search")).toBe(false);
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

  it("returns [] for output without an images array", () => {
    const parts = [
      toolPart("generate_image", { prompt: "no images key" }),
      toolPart("edit_image", { images: null }),
      toolPart("generate_image", undefined),
    ];

    expect(collectGeneratedImages(parts)).toEqual([]);
  });

  it("returns [] for malformed JSON string output", () => {
    const parts = [toolPart("generate_image", "{not valid json")];

    expect(collectGeneratedImages(parts)).toEqual([]);
  });

  it("returns [] for bare-array output (array shape is not supported)", () => {
    const parts = [toolPart("generate_image", [imageMeta({ imageId: "img-7" })])];

    expect(collectGeneratedImages(parts)).toEqual([]);
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

  it("collects a view_image web photo from a vision ToolResultContent output", () => {
    const parts = [
      toolPart("view_image", [
        {
          type: "text",
          text: JSON.stringify({
            images: [
              {
                imageId: "w1",
                modelId: "web",
                prompt: "q",
                width: 0,
                height: 0,
                mediaType: "image/jpeg",
                index: 0,
                total: 1,
                source: "web",
                sourceUrl: "https://example.com/a.jpg",
              },
            ],
            sourceUrl: "https://example.com/other.jpg",
          }),
        },
        { type: "image", data: "aGk=", mediaType: "image/jpeg" },
      ]),
    ];

    const images = collectGeneratedImagesFromMessages([message(parts)]);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      imageId: "w1",
      mediaType: "image/jpeg",
      source: "web",
      sourceUrl: "https://example.com/a.jpg",
    });
  });

  it("collects a view_image web photo from a description JSON string output", () => {
    const parts = [
      toolPart(
        "view_image",
        JSON.stringify({
          images: [
            {
              imageId: "w2",
              modelId: "web",
              prompt: "q",
              width: 0,
              height: 0,
              mediaType: "image/png",
              index: 0,
              total: 1,
            },
          ],
          description: "A cat",
          sourceUrl: "https://example.com/c.png",
        }),
      ),
    ];

    const images = collectGeneratedImagesFromMessages([message(parts)]);
    expect(images).toHaveLength(1);
    expect(images[0]!.imageId).toBe("w2");
    expect(images[0]!.source).toBe("web");
    expect(images[0]!.sourceUrl).toBe("https://example.com/c.png");
  });
});

function storedMeta(overrides: Record<string, unknown> = {}): GeneratedImageMeta {
  return {
    id: "stored-0",
    sessionId: "s1",
    projectId: null,
    mediaType: "image/png",
    width: 1024,
    height: 1024,
    modelId: "openai/gpt-5-image-mini",
    prompt: "stored prompt",
    nOfTotal: null,
    source: "generated",
    sourceUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeGeneratedImages", () => {
  it("combines live images before history, deduping by id", () => {
    const live = [
      imageMeta({ imageId: "live-1", prompt: "live prompt", total: 2, index: 1 }),
      imageMeta({ imageId: "both", prompt: "live wins" }),
    ];
    const history = [
      storedMeta({ id: "both", prompt: "history loses" }),
      storedMeta({ id: "stored-2", nOfTotal: "1 of 4" }),
    ];

    expect(mergeGeneratedImages(live, history)).toEqual([
      {
        id: "live-1",
        modelId: "openai/gpt-5-image-mini",
        prompt: "live prompt",
        width: 1024,
        height: 1024,
        mediaType: "image/png",
        nOfTotal: "2 of 2",
        source: "generated",
        sourceUrl: null,
      },
      {
        id: "both",
        modelId: "openai/gpt-5-image-mini",
        prompt: "live wins",
        width: 1024,
        height: 1024,
        mediaType: "image/png",
        nOfTotal: null,
        source: "generated",
        sourceUrl: null,
      },
      {
        id: "stored-2",
        modelId: "openai/gpt-5-image-mini",
        prompt: "stored prompt",
        width: 1024,
        height: 1024,
        mediaType: "image/png",
        nOfTotal: "1 of 4",
        source: "generated",
        sourceUrl: null,
      },
    ]);
  });

  it("returns [] when both lists are empty", () => {
    expect(mergeGeneratedImages([], [])).toEqual([]);
  });
});

describe("toGeneratedImageItem", () => {
  it("normalizes a stored meta keeping the server nOfTotal string", () => {
    expect(toGeneratedImageItem(storedMeta({ nOfTotal: "3 of 4" }))).toEqual({
      id: "stored-0",
      modelId: "openai/gpt-5-image-mini",
      prompt: "stored prompt",
      width: 1024,
      height: 1024,
      mediaType: "image/png",
      nOfTotal: "3 of 4",
      source: "generated",
      sourceUrl: null,
    });
  });
});

describe("countRunningImageToolPartsFromMessages", () => {
  it("counts distinct image tool parts still streaming input", () => {
    const messages = [
      message([
        toolPart("generate_image", undefined, "input-streaming"),
        toolPart("edit_image", undefined, "input-available"),
        toolPart("generate_image", { images: [] }, "output-available"),
        toolPart("generate_image", undefined, "error"),
        toolPart("web_search", undefined, "input-streaming"),
      ]),
      message([
        toolPart("generate_image", undefined, "input-streaming"),
      ]),
    ];

    expect(countRunningImageToolPartsFromMessages(messages)).toBe(3);
  });

  it("returns 0 when no image tool is in flight", () => {
    const messages = [
      message([
        toolPart("generate_image", { images: [] }, "output-available"),
        toolPart("edit_image", undefined, "error"),
        toolPart("web_search", undefined, "input-streaming"),
      ]),
    ];

    expect(countRunningImageToolPartsFromMessages(messages)).toBe(0);
  });
});

describe("groupImageToolRuns", () => {
  it("groups consecutive image tool parts into one run", () => {
    const parts = [
      toolPart("generate_image", undefined, "output-available"),
      toolPart("generate_image", undefined, "output-available"),
    ];
    const runs = groupImageToolRuns(parts);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(2);
  });

  it("splits runs separated by non-image parts", () => {
    const parts = [
      toolPart("generate_image", undefined, "output-available"),
      toolPart("web_search", undefined, "output-available"),
      toolPart("generate_image", undefined, "output-available"),
      toolPart("edit_image", undefined, "output-available"),
    ];
    const runs = groupImageToolRuns(parts);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(1);
    expect(runs[1]).toHaveLength(2);
  });

  it("returns no runs when there are no image tools", () => {
    const runs = groupImageToolRuns([
      toolPart("web_search", undefined, "output-available"),
    ]);
    expect(runs).toHaveLength(0);
  });
});

describe("imageItemsFromToolPart", () => {
  it("flattens a completed generate_image output into gallery items", () => {
    const part = toolPart("generate_image", {
      images: [
        {
          imageId: "img-1",
          modelId: "openai/gpt-5-image-mini",
          prompt: "a red panda",
          width: 1024,
          height: 1024,
          mediaType: "image/png",
          index: 0,
          total: 2,
        },
        {
          imageId: "img-2",
          modelId: "openai/gpt-5-image-mini",
          prompt: "a red panda",
          width: 1024,
          height: 1024,
          mediaType: "image/png",
          index: 1,
          total: 2,
        },
      ],
    });

    expect(imageItemsFromToolPart(part)).toEqual([
      {
        id: "img-1",
        modelId: "openai/gpt-5-image-mini",
        prompt: "a red panda",
        width: 1024,
        height: 1024,
        mediaType: "image/png",
        nOfTotal: "1 of 2",
        source: "generated",
        sourceUrl: null,
      },
      {
        id: "img-2",
        modelId: "openai/gpt-5-image-mini",
        prompt: "a red panda",
        width: 1024,
        height: 1024,
        mediaType: "image/png",
        nOfTotal: "2 of 2",
        source: "generated",
        sourceUrl: null,
      },
    ]);
  });

  it("returns [] while the tool is still running", () => {
    const part = toolPart("generate_image", undefined, "input-streaming");
    expect(imageItemsFromToolPart(part)).toEqual([]);
  });

  it("returns [] for non-image tool parts", () => {
    const part = toolPart("web_search", { results: [] });
    expect(imageItemsFromToolPart(part)).toEqual([]);
  });
});
