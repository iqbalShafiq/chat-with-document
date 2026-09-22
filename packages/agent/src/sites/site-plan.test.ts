import { describe, expect, it, vi } from "vitest";
import type { CompletionModel } from "@anvia/core/completion";
import {
  SITE_BRIEF_MAX_PROMPT_CHARS,
  extractSiteBriefJson,
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

describe("extractSiteBriefJson", () => {
  const brief = {
    siteName: "Kopi Senja",
    audience: "pecinta kopi",
    cta: "Pesan Sekarang",
    sections: ["hero", "kontak"],
    vibe: "hangat",
  };

  it("extracts JSON from a fenced code block with surrounding commentary", () => {
    const text = `Siap! Berikut briefnya:\n\`\`\`json\n${JSON.stringify(brief)}\n\`\`\`\nSemoga membantu!`;
    expect(extractSiteBriefJson(text)).toEqual(brief);
  });

  it("parses a bare JSON object", () => {
    expect(extractSiteBriefJson(JSON.stringify(brief))).toEqual(brief);
  });

  it("throws when the text contains no JSON object", () => {
    expect(() => extractSiteBriefJson("Maaf, saya tidak mengerti.")).toThrow(
      /no JSON object/i,
    );
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

  it("falls back to JSON-from-text when structured output fails", async () => {
    const brief = {
      siteName: "Kopi Senja",
      audience: "pecinta kopi",
      cta: "Pesan Sekarang",
      sections: ["hero", "kontak"],
      vibe: "hangat",
    };
    const texts = [
      "not json",
      `Siap! Berikut briefnya:\n\`\`\`json\n${JSON.stringify(brief)}\n\`\`\``,
    ];
    const completion = vi.fn(async () => ({
      choice: [
        {
          type: "text" as const,
          text: texts[Math.min(completion.mock.calls.length - 1, texts.length - 1)],
        },
      ],
      usage: { inputTokens: 5, outputTokens: 8 },
      rawResponse: {},
    }));
    const model = { ...fakeModel(""), completion } as unknown as CompletionModel;
    const result = await parseSiteBrief({ model, modelId: "stub", prompt: "x" });
    expect(result.brief).toEqual(brief);
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("rethrows auth errors without a second LLM call", async () => {
    const completion = vi.fn(async () => {
      throw Object.assign(new Error("401 Unauthorized"), {
        name: "CompletionAuthError",
      });
    });
    const model = { ...fakeModel(""), completion } as unknown as CompletionModel;
    await expect(
      parseSiteBrief({ model, modelId: "stub", prompt: "x" }),
    ).rejects.toThrow("401 Unauthorized");
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("rethrows timeout errors without a second LLM call", async () => {
    const completion = vi.fn(async () => {
      throw Object.assign(new Error("The operation timed out."), {
        name: "TimeoutError",
      });
    });
    const model = { ...fakeModel(""), completion } as unknown as CompletionModel;
    await expect(
      parseSiteBrief({ model, modelId: "stub", prompt: "x" }),
    ).rejects.toThrow("timed out");
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("caps the prompt length", () => {
    expect(SITE_BRIEF_MAX_PROMPT_CHARS).toBe(2000);
  });
});
