import { storageUsageSchema } from "../components.js";
import { bearerOrCookie, jsonResponse, unauthorized } from "../helpers.js";

export const usagePaths = {
  "/api/usage/summary": {
    get: {
      operationId: "getUsageSummary",
      tags: ["Usage"],
      summary: "Token and storage usage",
      description:
        "Aggregated token counts (all time) plus document storage. `tokens.maxTokens` is `null` — there is no hard token cap yet. Cost USD is not included here (provider cost is often unavailable).",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Usage summary.",
          {
            type: "object",
            required: ["storage", "tokens", "byModel", "byReasoningEffort"],
            properties: {
              storage: storageUsageSchema,
              tokens: {
                type: "object",
                required: [
                  "maxTokens",
                  "requestCount",
                  "inputTokens",
                  "outputTokens",
                  "totalTokens",
                  "cachedInputTokens",
                  "cacheCreationInputTokens",
                  "composition",
                ],
                properties: {
                  maxTokens: { type: "null" },
                  requestCount: { type: "integer" },
                  inputTokens: { type: "integer" },
                  outputTokens: { type: "integer" },
                  totalTokens: { type: "integer" },
                  cachedInputTokens: { type: "integer" },
                  cacheCreationInputTokens: { type: "integer" },
                  composition: {
                    type: "object",
                    required: ["inputUncached", "cacheRead", "output"],
                    properties: {
                      inputUncached: { type: "integer" },
                      cacheRead: { type: "integer" },
                      output: { type: "integer" },
                    },
                  },
                },
              },
              byModel: {
                type: "array",
                items: {
                  type: "object",
                  required: [
                    "model",
                    "requestCount",
                    "totalTokens",
                    "inputTokens",
                    "outputTokens",
                  ],
                  properties: {
                    model: { type: "string" },
                    requestCount: { type: "integer" },
                    totalTokens: { type: "integer" },
                    inputTokens: { type: "integer" },
                    outputTokens: { type: "integer" },
                  },
                },
              },
              byReasoningEffort: {
                type: "array",
                items: {
                  type: "object",
                  required: ["reasoningEffort", "requestCount", "totalTokens"],
                  properties: {
                    reasoningEffort: { type: "string" },
                    requestCount: { type: "integer" },
                    totalTokens: { type: "integer" },
                  },
                },
              },
            },
          },
          {
            default: {
              summary: "Active account",
              value: {
                storage: {
                  usedBytes: 12_582_912,
                  maxBytes: 209_715_200,
                  remainingBytes: 197_132_288,
                },
                tokens: {
                  maxTokens: null,
                  requestCount: 42,
                  inputTokens: 180_000,
                  outputTokens: 60_000,
                  totalTokens: 240_000,
                  cachedInputTokens: 20_000,
                  cacheCreationInputTokens: 5_000,
                  composition: {
                    inputUncached: 160_000,
                    cacheRead: 20_000,
                    output: 60_000,
                  },
                },
                byModel: [
                  {
                    model: "openai/gpt-5.6-luna",
                    requestCount: 40,
                    totalTokens: 230_000,
                    inputTokens: 172_000,
                    outputTokens: 58_000,
                  },
                ],
                byReasoningEffort: [
                  {
                    reasoningEffort: "high",
                    requestCount: 10,
                    totalTokens: 80_000,
                  },
                ],
              },
            },
          },
        ),
        "401": unauthorized,
      },
    },
  },
};
