import { describe, expect, it, vi } from "vitest";
import type { CompletionModel } from "@anvia/core/completion";
import {
  SITE_BRIEF_MAX_PROMPT_CHARS,
  isSiteBuilderIntent,
  parseSiteBrief,
} from "./site-plan.js";

function fakeModel(text: string): CompletionModel {
  return {
    provider: "stub",
    defaultModel: "stub-brief",
    capabilities: {
      streaming: false,
      tools: false,
      toolChoice: false,
      imageInput: false,
      documentInput: false,
      outputSchema: true,
      reasoning: false,
    },
    completion: vi.fn(async () => ({
      choice: [{ type: "text", text }],
      usage: { inputTokens: 5, outputTokens: 8 },
      rawResponse: {},
    })),
  } as unknown as CompletionModel;
}

describe("isSiteBuilderIntent", () => {
  it("matches builder requests in Indonesian and English", () => {
    expect(isSiteBuilderIntent("bikinkan landing page untuk kopi saya")).toBe(true);
    expect(isSiteBuilderIntent("build a company profile website")).toBe(true);
    expect(isSiteBuilderIntent("buatkan website statis portofolio")).toBe(true);
  });

  it("rejects ordinary chat", () => {
    expect(isSiteBuilderIntent("jelaskan regresi linear")).toBe(false);
    expect(isSiteBuilderIntent("berapa 2 tambah 2?")).toBe(false);
  });
});

describe("parseSiteBrief", () => {
  it("returns the structured brief with usage", async () => {
    const brief = {
      siteName: "Kopi Senja",
      audience: "pecinta kopi",
      cta: "Pesan Sekarang",
      sections: ["hero", "menu", "testimoni", "kontak"],
      vibe: "hangat minimalis",
    };
    const result = await parseSiteBrief({
      model: fakeModel(JSON.stringify(brief)),
      modelId: "stub",
      prompt: "bikinkan landing page untuk Kopi Senja",
    });

    expect(result.brief).toEqual(brief);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 8 });
  });

  it("throws when the model returns non-JSON structured output", async () => {
    await expect(
      parseSiteBrief({ model: fakeModel("not json"), modelId: "stub", prompt: "x" }),
    ).rejects.toThrow();
  });

  it("caps the prompt length", () => {
    expect(SITE_BRIEF_MAX_PROMPT_CHARS).toBe(2000);
  });
});
