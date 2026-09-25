import { describe, expect, it } from "vitest";
import { SITE_VIEW_TOOL_DEFINITIONS } from "./site-viewing.js";

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
