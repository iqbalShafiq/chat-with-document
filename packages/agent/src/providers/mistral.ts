import { MistralClient } from "@anvia/mistral";

export const mistral = new MistralClient({
  apiKey: process.env.MISTRAL_API_KEY ?? "",
});

export const DEFAULT_MISTRAL_OCR_MODEL = "mistral-ocr-latest";

export const ocrModel = mistral.ocrModel({
  modelId: DEFAULT_MISTRAL_OCR_MODEL,
});

export const embeddingModel = mistral.embeddingModel({
  modelId: "mistral-embed",
  dimensions: 1024,
  maxBatchSize: 32,
});
