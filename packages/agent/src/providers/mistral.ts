import { MistralClient } from "@anvia/mistral";

export const mistral = new MistralClient({
  apiKey: process.env.MISTRAL_API_KEY,
});

export const ocrModel = mistral.ocrModel();

export const embeddingModel = mistral.embeddingModel("mistral-embed", {
  dimensions: 1024,
  maxBatchSize: 32,
});
