import { describe, expect, it, vi } from "vitest";
import type { CompletionModel } from "@anvia/core/completion";
import {
  SESSION_TITLE_INSTRUCTIONS,
  SESSION_TITLE_MAX_PROMPT_CHARS,
  buildSessionTitlePrompt,
  generateSessionTitle,
  sanitizeGeneratedTitle,
} from "./session-title.js";

function fakeModel(
  text: string,
  overrides: { reasoning?: boolean } = {},
): CompletionModel {
  return {
    provider: "stub",
    defaultModel: "openai/stub-title",
    capabilities: {
      streaming: false,
      tools: false,
      toolChoice: false,
      imageInput: false,
      documentInput: false,
      outputSchema: true,
      reasoning: overrides.reasoning ?? true,
    },
    completion: vi.fn(async () => ({
      choice: [{ type: "text", text }],
      usage: { inputTokens: 3, outputTokens: 2 },
      rawResponse: {},
    })),
  } as unknown as CompletionModel;
}

function completedRequest(model: CompletionModel): Record<string, unknown> {
  const completion = model.completion as unknown as {
    mock: { calls: Array<[Record<string, unknown>]> };
  };
  return completion.mock.calls[0]![0]!;
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
      modelId: "openai/stub-title",
      prompt: "Tolong ringkas dokumen hukum ini",
    });

    expect(result.title).toBe("Judul Bersih");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it("requests minimal reasoning without pinning an output budget", async () => {
    const model = fakeModel(JSON.stringify({ title: "Judul" }));
    await generateSessionTitle({
      model,
      modelId: "openai/stub-title",
      prompt: "halooo! salam kenal boy!",
    });

    const request = completedRequest(model);
    expect(request.maxTokens).toBeUndefined();
    expect(request.providerOptions).toEqual({
      reasoning: { effort: "minimal" },
    });
  });

  it("uses chat-completions reasoning control for meta models", async () => {
    const model = fakeModel(JSON.stringify({ title: "Judul" }));
    await generateSessionTitle({
      model,
      modelId: "meta/muse-spark-1.3-contributor",
      prompt: "halooo! salam kenal boy!",
    });

    expect(completedRequest(model).providerOptions).toEqual({
      reasoning_effort: "minimal",
    });
  });

  it("omits reasoning controls for non-reasoning models", async () => {
    const model = fakeModel(JSON.stringify({ title: "Judul" }), {
      reasoning: false,
    });
    await generateSessionTitle({
      model,
      modelId: "openai/stub-title",
      prompt: "halooo! salam kenal boy!",
    });

    expect(completedRequest(model).providerOptions).toBeUndefined();
  });

  it("throws when the model returns non-JSON structured output", async () => {
    await expect(
      generateSessionTitle({
        model: fakeModel("not json"),
        modelId: "openai/stub-title",
        prompt: "x",
      }),
    ).rejects.toThrow();
  });

  it("keeps language and length rules in the instructions", () => {
    expect(SESSION_TITLE_INSTRUCTIONS).toContain("same language");
    expect(SESSION_TITLE_INSTRUCTIONS).toContain("6 words");
  });
});
