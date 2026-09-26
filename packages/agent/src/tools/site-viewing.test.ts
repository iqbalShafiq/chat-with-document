import { describe, expect, it, vi } from "vitest";
import {
  SITE_VIEW_TOOL_DEFINITIONS,
  createBrowseSiteTools,
  createViewSitePageTools,
} from "./site-viewing.js";

describe("SITE_VIEW_TOOL_DEFINITIONS", () => {
  it("exposes view_site_page and browse_site with one action per call", () => {
    expect(SITE_VIEW_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([
      "view_site_page",
      "browse_site",
    ]);
    const browse = SITE_VIEW_TOOL_DEFINITIONS.find((d) => d.name === "browse_site")!;
    const params = browse.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(params.required.sort()).toEqual(["action", "siteId"]);
    expect(
      (params.properties.action as { enum?: string[] }).enum?.sort(),
    ).toEqual(["click", "close", "open", "scroll", "snapshot"]);
  });
});

describe("createBrowseSiteTools", () => {
  const browseResult = () => ({
    siteId: "kedai",
    version: 1,
    action: "scroll" as const,
    title: "Kedai",
    url: "http://localhost:4312/api/sites/kedai/v1/preview/index.html",
    imageId: "img-2",
    blocked: false,
    note: null,
    actionsUsed: 2,
    actionsRemaining: 10,
    sessionState: "open" as const,
    captureError: null,
    retryable: false,
  });

  it("passes the action through and queues vision bytes", async () => {
    const pushVisionImage = vi.fn(async () => undefined);
    const act = vi.fn(async () => browseResult());
    const tools = createBrowseSiteTools({ act, pushVisionImage });
    expect(tools.map((t) => t.name)).toEqual(["browse_site"]);
    const out = (await tools[0]!.call({
      siteId: "kedai",
      action: "scroll",
      to: "bottom",
    })) as unknown as Record<string, unknown>;
    expect(act).toHaveBeenCalledWith({ siteId: "kedai", action: "scroll", to: "bottom" });
    expect(out).toMatchObject({ imageId: "img-2", imageBytesIncluded: true });
    expect(pushVisionImage).toHaveBeenCalledWith({ imageId: "img-2" });
  });

  it("focuses the site when opening a browse session", async () => {
    const focused: Array<{ artifactId: string; artifactType: string; label?: string }> = [];
    const tools = createBrowseSiteTools({
      act: async () => ({ ...browseResult(), action: "open" }),
      onFocus: (f) => {
        focused.push({
          artifactId: f.artifactId,
          artifactType: f.artifactType,
          ...(f.label !== undefined ? { label: f.label } : {}),
        });
      },
    });
    await tools[0]!.call({ siteId: "kedai", action: "open" });
    expect(focused).toEqual([{ artifactId: "kedai", artifactType: "site", label: "Kedai" }]);
  });

  it("skips the vision queue for text-only models", async () => {
    const pushVisionImage = vi.fn(async () => undefined);
    const tools = createBrowseSiteTools({
      act: async () => browseResult(),
      pushVisionImage,
      includeImageBytes: false,
    });
    const out = (await tools[0]!.call({
      siteId: "kedai",
      action: "snapshot",
    })) as unknown as Record<string, unknown>;
    expect(out).toMatchObject({ imageId: "img-2", imageBytesIncluded: false });
    expect(pushVisionImage).not.toHaveBeenCalled();
  });
});

describe("createViewSitePageTools", () => {
  const viewResult = async () => ({
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

  it("skips the vision queue when there is no image", async () => {
    const pushVisionImage = vi.fn(async () => undefined);
    const tools = createViewSitePageTools({
      view: async () => ({ ...viewResult(), imageId: "" }),
      pushVisionImage,
    });
    const out = (await tools[0]!.call({ siteId: "kedai" })) as unknown as Record<string, unknown>;
    expect(out).toMatchObject({ imageId: "", imageBytesIncluded: false });
    expect(pushVisionImage).not.toHaveBeenCalled();
  });
});
