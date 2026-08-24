import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientConstructed: 0,
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
    constructor() {
      mocks.clientConstructed += 1;
    }

    embeddingModel(options: unknown) {
      return mocks.embeddingModel(options);
    }

    ocrModel(options: unknown) {
      return mocks.ocrModel(options);
    }
  },
}));

import {
  createEmbeddingModel,
  createOcrModel,
} from "./mistral.js";

describe("Mistral provider", () => {
  beforeEach(() => {
    mocks.embeddingModel.mockClear();
    mocks.ocrModel.mockClear();
    vi.stubEnv("MISTRAL_API_KEY", "sk-test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not construct a client while the provider module is imported", () => {
    expect(mocks.clientConstructed).toBe(0);
  });

  it("constructs embedding and OCR handles with Anvia v1 object contracts", () => {
    const embeddingModel = createEmbeddingModel();
    const ocrModel = createOcrModel();

    expect(mocks.clientConstructed).toBe(1);
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
