import { describe, expect, it, vi } from "vitest";
import { createViewImageTool, type ViewImageToolOptions } from "./vision-helper.js";
import type { CompletionModel } from "@anvia/core/completion";
import type { ImageStore } from "../images/service.js";

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
