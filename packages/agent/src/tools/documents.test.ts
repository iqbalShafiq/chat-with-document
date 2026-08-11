import { describe, expect, it, vi } from "vitest";
import type { ToolResultContent } from "@anvia/core";
import {
  createGetDocumentPageImagesTool,
  type PageImagesPrisma,
  type SessionDocumentIdsPrisma,
} from "./documents.js";

const SESSION_IDS: SessionDocumentIdsPrisma = {
  documentSession: {
    findMany: async () => [{ documentId: "doc-1" }],
  },
};

function pageImagesPrisma(images: unknown): PageImagesPrisma {
  return {
    documentPage: {
      findFirst: async () => ({ id: "page-1", images }),
    },
  };
}

function toolResultText(result: ToolResultContent[]): Record<string, unknown> {
  const text = result.find((part) => part.type === "text");
  return JSON.parse(text && text.type === "text" ? text.text : "{}") as Record<
    string,
    unknown
  >;
}

const FIXTURE_IMAGES = [
  {
    id: "img-1",
    r2Key: "key-1",
    mediaType: "image/png",
    annotation: "Chart: revenue by quarter",
  },
];

describe("get_document_page_images includeImageBytes", () => {
  it("omits image bytes and skips fetchPageImage when includeImageBytes is false", async () => {
    const fetchPageImage = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const tool = createGetDocumentPageImagesTool({
      userId: "u-1",
      sessionId: "s-1",
      prisma: {
        ...SESSION_IDS,
        ...pageImagesPrisma(FIXTURE_IMAGES),
      },
      fetchPageImage,
      includeImageBytes: false,
    });

    const result = await tool.call({
      documentId: "doc-1",
      pageIndex: 0,
      limit: 5,
    });

    const text = toolResultText(result);
    expect(text).toMatchObject({ found: true, pageIndex: 0 });
    expect(text.images).toEqual([
      {
        id: "img-1",
        mediaType: "image/png",
        markdown:
          "![img-1](/api/documents/doc-1/pages/0/images/img-1)",
        annotation: "Chart: revenue by quarter",
      },
    ]);
    expect(result.some((part) => part.type === "image")).toBe(false);
    expect(fetchPageImage).not.toHaveBeenCalled();
  });

  it("includes image bytes by default (vision-capable models)", async () => {
    const fetchPageImage = vi.fn(async () => new Uint8Array([9, 8, 7]));
    const tool = createGetDocumentPageImagesTool({
      userId: "u-1",
      sessionId: "s-1",
      prisma: {
        ...SESSION_IDS,
        ...pageImagesPrisma(FIXTURE_IMAGES),
      },
      fetchPageImage,
    });

    const result = await tool.call({
      documentId: "doc-1",
      pageIndex: 0,
      limit: 5,
    });

    expect(fetchPageImage).toHaveBeenCalledWith("key-1");
    const imageParts = result.filter((part) => part.type === "image");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]).toMatchObject({ mediaType: "image/png" });
  });
});
