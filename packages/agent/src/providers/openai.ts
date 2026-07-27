import type { CompletionModel } from "@anvia/core";
import { OpenAIClient } from "@anvia/openai";

const openai = new OpenAIClient({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  completionApi: "responses",
});

export const defaultModel = openai.completionModel("gpt-5.6-luna");
