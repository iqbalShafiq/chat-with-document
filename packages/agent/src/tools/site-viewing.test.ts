import { describe, expect, it, vi } from "vitest";
import type { ToolResultContentPart } from "@anvia/core";
import { normalizeToolResultOutput } from "@anvia/core/tool";
import {
  SITE_VIEW_TOOL_DEFINITIONS,
  createViewSitePageTools,
} from "./site-viewing.js";

function toolResultContent(result: unknown): readonly ToolResultContentPart[] {
  const normalized = normalizeToolResultOutput(result);
  expect(normalized.type).toBe("content");
  if (normalized.type !== "content") {
    throw new Error(`Expected rich content, received ${normalized.type}`);
  }
  return normalized.value;
}

function toolResultText(result: unknown): Record<string, unknown> {
  const content = toolResultContent(result);
  const text = content.find((part) => part.type === "text");
  return JSON.parse(text && text.type === "text" ? text.text : "{}") as Record<
    string,
    unknown
  >;
}

describe("SITE_VIEW_TOOL_DEFINITIONS", () => {
  it("exposes exactly view_site_page with siteId/version/question params", () => {
    expect(SITE_VIEW_TOOL_DEFINITIONS.map((d) => d.name)).toEqual(["view_site_page"]);
    const params = SITE_VIEW_TOOL_DEFINITIONS[0]!.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(params.properties).sort()).toEqual(["question", "siteId", "version"]);
    expect(params.required).toEqual(["siteId"]);
  });
});

describe("createViewSitePageTools", () => {
  it("returns the composed view result and focuses the site", async () => {
    const focused: Array<{ artifactId: string; artifactType: string }> = [];
    const result = {
      siteId: "kedai",
      version: 2,
      status: "ready",
      title: "Kedai",
      headings: [],
      excerpt: "Halo",
      excerptTruncated: false,
      imageId: "img-7",
      capturedAt: "t",
      viewport: { width: 1440, height: 900 },
      fullPage: true,
      truncated: false,
    };
    const tools = createViewSitePageTools({
      view: async () => result,
      onFocus: (f) => {
        focused.push({ artifactId: f.artifactId, artifactType: f.artifactType });
      },
    });
    expect(tools.map((t) => t.name)).toEqual(["view_site_page"]);
    const out = (await tools[0]!.call({ siteId: "kedai" })) as unknown;
    expect(toolResultText(out)).toMatchObject({ siteId: "kedai", version: 2, imageId: "img-7" });
    expect(focused).toEqual([{ artifactId: "kedai", artifactType: "site" }]);
  });

  it("attaches PNG bytes for vision models and omits them for text-only", async () => {
    const loadImageBytes = vi.fn(async () => ({
      buffer: new Uint8Array([137, 80, 78, 71]),
      mediaType: "image/png",
    }));
    const view = async () => ({
      siteId: "kedai",
      version: 2,
      status: "ready",
      title: "Kedai",
      headings: [],
      excerpt: "Halo",
      excerptTruncated: false,
      imageId: "img-7",
      capturedAt: "t",
      viewport: { width: 1440, height: 900 },
      fullPage: true,
      truncated: false,
    });
    const vision = createViewSitePageTools({ view, loadImageBytes });
    const visionOut = await vision[0]!.call({ siteId: "kedai" });
    const visionContent = toolResultContent(visionOut);
    const files = visionContent.filter((part) => part.type === "file");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      mediaType: "image/png",
      data: { type: "data", data: "iVBORw==" },
    });
    expect(toolResultText(visionOut)).toMatchObject({ imageId: "img-7", imageBytesIncluded: true });
    expect(loadImageBytes).toHaveBeenCalledWith("img-7");

    const textOnly = createViewSitePageTools({ view, loadImageBytes, includeImageBytes: false });
    const textOut = await textOnly[0]!.call({ siteId: "kedai" });
    const textContent = toolResultContent(textOut);
    expect(textContent.some((part) => part.type === "file")).toBe(false);
    expect(toolResultText(textOut)).toMatchObject({ imageId: "img-7", imageBytesIncluded: false });
    expect(loadImageBytes).toHaveBeenCalledTimes(1);
  });
});
