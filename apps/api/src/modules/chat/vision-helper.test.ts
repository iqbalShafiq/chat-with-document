import { describe, expect, it, vi } from "vitest";
import {
  createViewImageTool,
  loadRemoteImage,
  type ViewImageToolOptions,
} from "./vision-helper.js";
import type { CompletionModel } from "@anvia/core/completion";
import type { ToolResultContent } from "@anvia/core";
import type { ImageStore } from "../images/service.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("node:net", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("node:net");
  return {
    ...mod,
    isIP: () => 0,
  };
});

const USER = "user-1";
const SESSION = "session-1";

function makeOptions(
  overrides: Partial<ViewImageToolOptions> = {},
): ViewImageToolOptions {
  return {
    userId: USER,
    sessionId: SESSION,
    store: {
      getImage: vi.fn(async () => null),
      getObjectBuffer: vi.fn(async () => new Uint8Array([1, 2, 3])),
      saveGeneratedImage: vi.fn(async (input: Record<string, unknown>) => ({
        id: "web-img-1", userId: USER, sessionId: SESSION, projectId: null,
        r2Key: "images/user-1/web-1", mediaType: "image/png", width: 0, height: 0,
        modelId: "web", prompt: String(input.prompt), nOfTotal: null,
        source: "web", sourceUrl: String(input.sourceUrl), createdAt: new Date(),
      })),
      findSessionImageBySourceUrl: vi.fn(async () => null),
    } as unknown as ImageStore,
    model: {
      provider: "stub",
      defaultModel: "stub-vision",
      capabilities: {
        streaming: false,
        tools: false,
        toolChoice: false,
        imageInput: true,
        documentInput: false,
        outputSchema: false,
        reasoning: false,
      },
      completion: vi.fn(async () => ({
        choice: [
          {
            type: "text",
            text: "A chart showing quarterly revenue.",
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        rawResponse: {},
      })),
    } as unknown as CompletionModel,
    ...overrides,
  };
}

describe("view_image document image resolution", () => {
  it("falls back to resolveDocumentImage when the id is not a session image", async () => {
    const resolveDocumentImage = vi.fn(async () => ({
      mediaType: "image/png",
      buffer: new Uint8Array([9, 9, 9]),
    }));
    const tool = createViewImageTool(makeOptions({ resolveDocumentImage }));

    const output = await tool.call({ imageId: "doc-img-1" });

    expect(resolveDocumentImage).toHaveBeenCalledWith("doc-img-1", USER, SESSION);
    expect(output).toBe("A chart showing quarterly revenue.");
  });

  it("reports the not-found error when neither store nor document resolver matches", async () => {
    const tool = createViewImageTool(
      makeOptions({ resolveDocumentImage: vi.fn(async () => null) }),
    );

    const output = await tool.call({ imageId: "missing-img" });

    expect(output).toContain("Image not found in this session");
    expect(output).toContain("get_document_page_images");
  });
});

describe("view_image universal", () => {
  it("vision mode returns image ToolResultContent for a public URL", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const tool = createViewImageTool(
      makeOptions({ mode: "vision", fetchFn: fakeFetch as unknown as typeof fetch }),
    );
    const result = (await tool.call({
      url: "https://example.com/photo.jpg",
    })) as ToolResultContent[];
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({ type: "text" });
    expect(result[1]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
  });

  it("description mode (non-vision) still returns text description", async () => {
    const resolveDocumentImage = vi.fn(async () => ({
      mediaType: "image/png",
      buffer: new Uint8Array([9, 9, 9]),
    }));
    const tool = createViewImageTool(
      makeOptions({ mode: "description", resolveDocumentImage }),
    );
    const output = await tool.call({ imageId: "doc-img-1" });
    expect(typeof output).toBe("string");
    expect(output).toBe("A chart showing quarterly revenue.");
  });

  it("vision mode also supports imageId by loading session image bytes", async () => {
    const store = {
      getImage: vi.fn(async () => ({
        userId: USER,
        sessionId: SESSION,
        r2Key: "k1",
        mediaType: "image/png",
      })),
      getObjectBuffer: vi.fn(async () => new Uint8Array([1, 2, 3])),
    } as unknown as ImageStore;
    const tool = createViewImageTool(makeOptions({ mode: "vision", store }));
    const result = (await tool.call({ imageId: "img-1" })) as ToolResultContent[];
    expect(result.some((p) => p.type === "image")).toBe(true);
  });

  it("persists a web URL photo (vision mode) and returns imageId in the text JSON", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const options = makeOptions({ mode: "vision", fetchFn: fakeFetch as never });
    const store = options.store as unknown as {
      saveGeneratedImage: ReturnType<typeof vi.fn>;
      findSessionImageBySourceUrl: ReturnType<typeof vi.fn>;
    };
    const tool = createViewImageTool(options);
    const result = (await tool.call({ url: "https://example.com/photo.jpg" })) as ToolResultContent[];
    expect(store.saveGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({
      source: "web", sourceUrl: "https://example.com/photo.jpg", modelId: "web",
    }));
    const text = result.find((p) => p.type === "text");
    const parsed = JSON.parse((text as { text: string }).text) as { images: Array<{ imageId: string }> };
    expect(parsed.images[0]!.imageId).toBe("web-img-1");
  });

  it("reuses an existing record when the same URL was already seen (dedup)", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const options = makeOptions({ mode: "vision", fetchFn: fakeFetch as never });
    const store = options.store as unknown as {
      saveGeneratedImage: ReturnType<typeof vi.fn>;
      findSessionImageBySourceUrl: ReturnType<typeof vi.fn>;
    };
    store.findSessionImageBySourceUrl.mockResolvedValue({ id: "existing-1", userId: USER, sessionId: SESSION, projectId: null, r2Key: "r", mediaType: "image/jpeg", width: 0, height: 0, modelId: "web", prompt: "p", nOfTotal: null, source: "web", sourceUrl: "https://example.com/photo.jpg", createdAt: new Date() } as never);
    const tool = createViewImageTool(options);
    await tool.call({ url: "https://example.com/photo.jpg" });
    expect(store.saveGeneratedImage).not.toHaveBeenCalled();
  });

  it("description mode returns JSON with images and description", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const tool = createViewImageTool(makeOptions({ mode: "description", fetchFn: fakeFetch as never }));
    const output = (await tool.call({ url: "https://example.com/photo.jpg" })) as string;
    const parsed = JSON.parse(output) as { images: unknown[]; description: string; sourceUrl: string };
    expect(parsed.description).toBe("A chart showing quarterly revenue.");
    expect(parsed.sourceUrl).toBe("https://example.com/photo.jpg");
    expect(Array.isArray(parsed.images)).toBe(true);
  });

  it("does NOT persist an imageId-path (session/document) view", async () => {
    const options = makeOptions({ mode: "vision" });
    const store = options.store as unknown as {
      saveGeneratedImage: ReturnType<typeof vi.fn>;
    };
    const resolveDoc = vi.fn(async () => ({ mediaType: "image/png", buffer: new Uint8Array([9, 9, 9]) }));
    const tool = createViewImageTool(makeOptions({ mode: "vision", resolveDocumentImage: resolveDoc, store: store as never }));
    await tool.call({ imageId: "doc-img-1" });
    expect(store.saveGeneratedImage).not.toHaveBeenCalled();
  });
});

describe("loadRemoteImage format bounds", () => {
  it("rejects non-raster images (e.g. SVG) so vision providers do not 400", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
    );
    const result = await loadRemoteImage({
      url: "https://example.com/logo.svg",
      fetchFn: fakeFetch as unknown as typeof fetch,
    });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/supported image format/i);
  });

  it("sniffs PNG magic bytes even when the content-type is generic", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const result = await loadRemoteImage({
      url: "https://example.com/photo",
      fetchFn: fakeFetch as unknown as typeof fetch,
    });
    expect("mediaType" in result).toBe(true);
    expect((result as { mediaType: string }).mediaType).toBe("image/png");
  });
});
