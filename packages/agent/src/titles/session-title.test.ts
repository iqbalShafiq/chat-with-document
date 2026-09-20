import { describe, expect, it, vi } from "vitest";
import type { CompletionModel } from "@anvia/core/completion";
import {
  SESSION_TITLE_INSTRUCTIONS,
  SESSION_TITLE_MAX_PROMPT_CHARS,
  buildSessionTitlePrompt,
  generateSessionTitle,
  sanitizeGeneratedTitle,
} from "./session-title.js";

function fakeModel(text: string): CompletionModel {
  return {
    provider: "stub",
    defaultModel: "stub-title",
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
      usage: { inputTokens: 3, outputTokens: 2 },
      rawResponse: {},
    })),
  } as unknown as CompletionModel;
}

describe("sanitizeGeneratedTitle", () => {
  it("strips labels, wrapping quotes, and trailing punctuation", () => {
    expect(sanitizeGeneratedTitle('Title: "Analisis Data Penjualan".')).toBe(
      "Analisis Data Penjualan",
    );
    expect(sanitizeGeneratedTitle("`Rencana Q3`")).toBe("Rencana Q3");
    expect(sanitizeGeneratedTitle("  Ringkasan   Dokumen \n Hukum  ")).toBe(
      "Ringkasan Dokumen Hukum",
    );
  });

  it("returns null when nothing is left", () => {
    expect(sanitizeGeneratedTitle("")).toBeNull();
    expect(sanitizeGeneratedTitle("  ...  ")).toBeNull();
  });
});

describe("buildSessionTitlePrompt", () => {
  it("collapses whitespace and caps the prompt length", () => {
    expect(buildSessionTitlePrompt("  hello \n world ")).toBe("hello world");
    expect(
      buildSessionTitlePrompt("a".repeat(SESSION_TITLE_MAX_PROMPT_CHARS + 500)),
    ).toHaveLength(SESSION_TITLE_MAX_PROMPT_CHARS);
  });
});

describe("generateSessionTitle", () => {
  it("returns the sanitized structured title with usage", async () => {
    const result = await generateSessionTitle({
      model: fakeModel(JSON.stringify({ title: '"Judul Bersih".' })),
      prompt: "Tolong ringkas dokumen hukum ini",
    });

    expect(result.title).toBe("Judul Bersih");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it("keeps reasoning models inside a usable output budget", async () => {
    const model = fakeModel(JSON.stringify({ title: "Judul" }));
    await generateSessionTitle({
      model,
      prompt: "halooo! salam kenal boy!",
    });

    const completion = model.completion as unknown as {
      mock: { calls: Array<[Record<string, unknown>]> };
    };
    const request = completion.mock.calls[0]![0]!;
    expect(request.maxTokens).toBeGreaterThanOrEqual(256);
    expect(request.providerOptions).toEqual({
      reasoning: { effort: "minimal" },
    });
  });

  it("throws when the model returns non-JSON structured output", async () => {
    await expect(
      generateSessionTitle({ model: fakeModel("not json"), prompt: "x" }),
    ).rejects.toThrow();
  });

  it("keeps language and length rules in the instructions", () => {
    expect(SESSION_TITLE_INSTRUCTIONS).toContain("same language");
    expect(SESSION_TITLE_INSTRUCTIONS).toContain("6 words");
  });
});
