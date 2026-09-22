import type { AnyTool } from "@anvia/core";
import { describe, expect, it, vi } from "vitest";
import {
  SITE_BUILD_TOOL_DEFINITIONS,
  SITE_BUILD_TOOL_INSTRUCTIONS,
  createSiteBuildTools,
} from "./site-build.js";
import type { SiteBrief } from "../sites/site-plan.js";

const BRIEF: SiteBrief = {
  siteName: "Kopi Senja",
  audience: "pecinta kopi",
  cta: "Pesan",
  sections: ["hero", "kontak"],
  vibe: "hangat",
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    parseBrief: vi.fn(async () => ({ brief: BRIEF, usage: { inputTokens: 1, outputTokens: 1 } })),
    readActiveSite: vi.fn(async () => null),
    enqueueBuild: vi.fn(async () => ({ siteId: "new-id", version: 1 })),
    ...overrides,
  };
}

async function callTool(tools: AnyTool[], name: string, input: unknown) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.call(input, {});
}

describe("propose_site_build", () => {
  it("returns create when no active site exists", async () => {
    const tools = createSiteBuildTools(deps());
    const result = await callTool(tools, "propose_site_build", { prompt: "bikinkan landing kopi" });
    expect(result).toMatchObject({ action: "create", brief: BRIEF });
  });

  it("returns create with different-topic when names differ", async () => {
    const tools = createSiteBuildTools(
      deps({ readActiveSite: vi.fn(async () => ({ siteId: "s-old", siteName: "Toko Roti" })) }),
    );
    const result = await callTool(tools, "propose_site_build", { prompt: "bikinkan landing kopi" });
    expect(result).toMatchObject({ action: "create", reason: "different-topic" });
  });

  it("returns ask with choices and recommendation when names match", async () => {
    const tools = createSiteBuildTools(
      deps({ readActiveSite: vi.fn(async () => ({ siteId: "s-1", siteName: "kopi senja" })) }),
    );
    const result = await callTool(tools, "propose_site_build", { prompt: "ganti headline" });
    expect(result).toMatchObject({
      action: "ask",
      recommendation: "iterate",
      choices: [{ id: "iterate" }, { id: "new-site" }],
    });
  });

  it("returns error instead of throwing when parsing fails", async () => {
    const tools = createSiteBuildTools(
      deps({ parseBrief: vi.fn(async () => { throw new Error("provider down"); }) }),
    );
    const result = await callTool(tools, "propose_site_build", { prompt: "x" });
    expect(result).toMatchObject({ action: "error" });
  });
});

describe("confirm_site_build", () => {
  it("enqueues iterate with the active site id", async () => {
    const enqueueBuild = vi.fn(async () => ({ siteId: "s-1", version: 2 }));
    const tools = createSiteBuildTools(deps({ enqueueBuild }));
    const result = await callTool(tools, "confirm_site_build", {
      brief: BRIEF,
      mode: "iterate",
      activeSiteId: "s-1",
    });
    expect(result).toEqual({ siteId: "s-1", version: 2 });
    expect(enqueueBuild).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "s-1", prompt: expect.any(String) }),
    );
  });

  it("enqueues new-site with null site id", async () => {
    const enqueueBuild = vi.fn(async () => ({ siteId: "s-2", version: 1 }));
    const tools = createSiteBuildTools(deps({ enqueueBuild }));
    await callTool(tools, "confirm_site_build", { brief: BRIEF, mode: "new-site" });
    expect(enqueueBuild).toHaveBeenCalledWith(expect.objectContaining({ siteId: null }));
  });
});

describe("definitions and instructions", () => {
  it("exposes two static definitions and the clarify-then-confirm rule", () => {
    expect(SITE_BUILD_TOOL_DEFINITIONS.map((definition) => definition.name).sort()).toEqual([
      "confirm_site_build",
      "propose_site_build",
    ]);
    expect(SITE_BUILD_TOOL_INSTRUCTIONS).toContain("request_clarification");
    expect(SITE_BUILD_TOOL_INSTRUCTIONS).toContain("confirm_site_build");
  });
});
