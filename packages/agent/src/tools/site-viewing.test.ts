import { describe, expect, it } from "vitest";
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
    expect(out).toMatchObject({ siteId: "kedai", version: 2, imageId: "img-7" });
    expect(focused).toEqual([{ artifactId: "kedai", artifactType: "site" }]);
  });
});
