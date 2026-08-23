import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embeddingModel: vi.fn((_options: unknown) => ({
    provider: "mistral",
    modelId: "mistral-embed",
  })),
  ocrModel: vi.fn((_options: unknown) => ({
    provider: "mistral",
    modelId: "mistral-ocr-latest",
  })),
}));

vi.mock("@anvia/mistral", () => ({
  MistralClient: class {
    embeddingModel(options: unknown) {
      return mocks.embeddingModel(options);
    }

    ocrModel(options: unknown) {
      return mocks.ocrModel(options);
    }
  },
}));

import { embeddingModel, ocrModel } from "./mistral.js";

describe("Mistral provider", () => {
  it("constructs embedding and OCR handles with Anvia v1 object contracts", () => {
    expect(mocks.embeddingModel).toHaveBeenCalledOnce();
    expect(mocks.embeddingModel).toHaveBeenCalledWith({
      modelId: "mistral-embed",
      dimensions: 1024,
      maxBatchSize: 32,
    });
    expect(mocks.ocrModel).toHaveBeenCalledOnce();
    expect(mocks.ocrModel).toHaveBeenCalledWith({
      modelId: "mistral-ocr-latest",
    });
    expect(embeddingModel).toEqual({
      provider: "mistral",
      modelId: "mistral-embed",
    });
    expect(ocrModel).toEqual({
      provider: "mistral",
      modelId: "mistral-ocr-latest",
    });
  });
});
