import type { EmbeddingModel } from "@anvia/core/embeddings";
import { MistralClient } from "@anvia/mistral";

export const DEFAULT_MISTRAL_OCR_MODEL = "mistral-ocr-latest";

let mistralClient: MistralClient | null = null;

/**
 * Provider construction is deliberately process-lazy. Importing the agent
 * package is also used by pure adapters and must not require live credentials.
 */
export function getMistralClient(): MistralClient {
  if (mistralClient) return mistralClient;

  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is required to create a Mistral provider.");
  }

  mistralClient = new MistralClient({ apiKey });
  return mistralClient;
}

export function createOcrModel() {
  return getMistralClient().ocrModel({
    modelId: DEFAULT_MISTRAL_OCR_MODEL,
  });
}

export function createEmbeddingModel(): EmbeddingModel {
  return getMistralClient().embeddingModel({
    modelId: "mistral-embed",
    dimensions: 1024,
    maxBatchSize: 32,
  });
}
