import { modelInfoSchema } from "../components.js";
import {
  badRequest,
  bearerOrCookie,
  jsonResponse,
  unauthorized,
} from "../helpers.js";

export const modelsPaths = {
  "/api/models": {
    get: {
      operationId: "listModels",
      tags: ["Models"],
      summary: "List the model catalog",
      description:
        "Active chat and image models from the `chat_model` registry, plus the reasoning-effort catalog. Filter with `outputType=text` or `outputType=image`.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "outputType",
          in: "query",
          schema: { type: "string", enum: ["text", "image"] },
          example: "text",
        },
      ],
      responses: {
        "200": jsonResponse(
          "Catalog.",
          {
            type: "object",
            required: ["models", "reasoningEfforts"],
            properties: {
              models: { type: "array", items: modelInfoSchema },
              reasoningEfforts: {
                type: "array",
                items: {
                  type: "object",
                  required: ["key", "label", "sortOrder"],
                  properties: {
                    key: { type: "string" },
                    label: { type: "string" },
                    description: { type: ["string", "null"] },
                    sortOrder: { type: "integer" },
                  },
                },
              },
            },
          },
          {
            default: {
              summary: "One chat model",
              value: {
                models: [
                  {
                    modelId: "openai/gpt-5.6-luna",
                    label: "Luna",
                    name: "GPT 5.6 Luna",
                    hint: "Default chat model",
                    description: "Balanced reasoning and speed.",
                    iconSvg: "<svg />",
                    provider: { slug: "openai", name: "OpenAI" },
                    contextWindowTokens: 200000,
                    maxInputTokens: null,
                    maxOutputTokens: null,
                    prices: {
                      input: 1.25,
                      cachedInput: 0.125,
                      output: 10,
                      cacheWriteMultiplier: null,
                      longPromptThresholdTokens: null,
                      longPromptInputMultiplier: null,
                      longPromptOutputMultiplier: null,
                    },
                    reasoningEfforts: ["low", "medium", "high"],
                    outputType: "text",
                    imageCapabilities: null,
                    inputModalities: ["text", "image"],
                    sortOrder: 10,
                  },
                ],
                reasoningEfforts: [
                  {
                    key: "low",
                    label: "Low",
                    description: "Faster, cheaper",
                    sortOrder: 1,
                  },
                  {
                    key: "medium",
                    label: "Medium",
                    description: null,
                    sortOrder: 2,
                  },
                  {
                    key: "high",
                    label: "High",
                    description: "Deeper reasoning",
                    sortOrder: 3,
                  },
                ],
              },
            },
          },
        ),
        "400": badRequest({ error: "outputType must be 'text' or 'image'" }),
        "401": unauthorized,
      },
    },
  },
};
