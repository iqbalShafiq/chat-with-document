import { describe, expect, it, vi } from "vitest";
import {
  SITE_VIEW_TOOL_DEFINITIONS,
  createViewSitePageTools,
} from "./site-viewing.js";

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
  const viewResult = () => ({
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

  it("returns the composed view result and focuses the site", async () => {
    const focused: Array<{ artifactId: string; artifactType: string }> = [];
    const tools = createViewSitePageTools({
      view: async () => viewResult(),
      onFocus: (f) => {
        focused.push({ artifactId: f.artifactId, artifactType: f.artifactType });
      },
    });
    expect(tools.map((t) => t.name)).toEqual(["view_site_page"]);
    const out = (await tools[0]!.call({ siteId: "kedai" })) as unknown as Record<string, unknown>;
    expect(out).toMatchObject({ siteId: "kedai", version: 2, imageId: "img-7" });
    expect(focused).toEqual([{ artifactId: "kedai", artifactType: "site" }]);
  });

  it("queues screenshot bytes for vision models and skips for text-only", async () => {
    const pushVisionImage = vi.fn(async () => undefined);
    const vision = createViewSitePageTools({ view: viewResult, pushVisionImage });
    const visionOut = (await vision[0]!.call({ siteId: "kedai" })) as unknown as Record<string, unknown>;
    expect(visionOut).toMatchObject({ imageId: "img-7", imageBytesIncluded: true });
    expect(pushVisionImage).toHaveBeenCalledWith({ imageId: "img-7" });

    const textOnly = createViewSitePageTools({
      view: viewResult,
      pushVisionImage,
      includeImageBytes: false,
    });
    const textOut = (await textOnly[0]!.call({ siteId: "kedai" })) as unknown as Record<string, unknown>;
    expect(textOut).toMatchObject({ imageId: "img-7", imageBytesIncluded: false });
    expect(pushVisionImage).toHaveBeenCalledTimes(1);
  });

  it("reports bytes as missing when the vision queue rejects", async () => {
    const tools = createViewSitePageTools({
      view: viewResult,
      pushVisionImage: async () => {
        throw new Error("queue down");
      },
    });
    const out = (await tools[0]!.call({ siteId: "kedai" })) as unknown as Record<string, unknown>;
    expect(out).toMatchObject({ imageId: "img-7", imageBytesIncluded: false });
  });
});
