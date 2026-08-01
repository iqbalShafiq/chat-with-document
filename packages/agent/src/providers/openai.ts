import type { CompletionModel } from "@anvia/core";
import { OpenAIClient } from "@anvia/openai";

/** Keep in sync with the model string passed to completionModel(). */
export const DEFAULT_COMPLETION_MODEL = "gpt-5.6-luna";
export const DEFAULT_COMPLETION_PROVIDER = "openai";

const openai = new OpenAIClient({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  completionApi: "responses",
});

export const defaultModel = openai.completionModel(
  DEFAULT_COMPLETION_MODEL,
) as CompletionModel;
