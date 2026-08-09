import { createTool } from "@anvia/core";
import {
  createCompletion,
  Message,
  UserContent,
  type CompletionModel,
} from "@anvia/core/completion";
import { z } from "zod";
import {
  getImageStore,
  type ImageStore,
} from "../images/service.js";
import { findActiveModel, listModels } from "../models/service.js";

export const VISION_HELPER_INSTRUCTION =
  "Your model cannot receive image input. To understand an image from the " +
  "conversation (active image context or session history), call view_image " +
  "with its imageId — it returns an accurate text description of the actual " +
  "image content.";

const VIEW_IMAGE_DESCRIPTION =
  "View a conversation image (by imageId from the active image context or " +
  "session history) and describe what it actually shows. Use when the user " +
  "asks about an image but your model cannot receive image input.";

const VIEW_IMAGE_INSTRUCTIONS =
  "Describe the image accurately and concisely, focusing on what is visible: " +
  "subjects, composition, style, colors, and any text. Answer the user's " +
  "question if one is given. Do not speculate about content you cannot see.";

export type ViewImageToolOptions = {
  userId: string;
  sessionId: string;
  store: ImageStore;
  model: CompletionModel;
};

/**
 * Subagent-as-tool for text-only models: a narrow, read-only tool that
 * describes a session image via a vision-capable chat model (direct
 * completion — no agent loop needed). Registered only when the run's model
 * cannot accept image input, so DeepSeek-class models can "see" the actual
 * image content instead of only the prompt text.
 */
export function createViewImageTool(options: ViewImageToolOptions) {
  const { userId, sessionId, store, model } = options;
  return createTool({
    name: "view_image",
    description: VIEW_IMAGE_DESCRIPTION,
    input: z.object({
      imageId: z.string().describe("Session generated image id (see the active image context block)."),
      question: z
        .string()
        .optional()
        .describe("Optional specific question to answer about the image."),
    }),
    execute: async ({ imageId, question }) => {
      const image = await store.getImage(imageId);
      if (!image || image.userId !== userId || image.sessionId !== sessionId) {
        return "Image not found in this session. Use an imageId from the active image context or session history.";
      }
      try {
        const data = await store.getObjectBuffer(image.r2Key);
        const result = await createCompletion(model, {
          messages: [
            Message.user([
              UserContent.imageBase64(
                Buffer.from(data).toString("base64"),
                image.mediaType,
                { detail: "auto" },
              ),
              UserContent.text(
                question ?? "Describe this image accurately and concisely.",
              ),
            ]),
          ],
          instructions: VIEW_IMAGE_INSTRUCTIONS,
        });
        return result.text;
      } catch (error) {
        console.error("[chat] view_image failed", {
          imageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return "Failed to view the image. Try again or skip it.";
      }
    },
  });
}

/**
 * Resolve the vision model used by view_image: VISION_HELPER_MODEL env
 * override when it is an active image-capable model, otherwise the cheapest
 * active vision chat model in the registry.
 */
export async function resolveVisionHelperModel(): Promise<CompletionModel | null> {
  // Lazy import: constructing the OpenAI client at module load fails in
  // test environments without credentials.
  const { createCompletionModel } = await import("@assingment/agent");
  const envModelId = process.env.VISION_HELPER_MODEL;
  if (envModelId) {
    const info = await findActiveModel(envModelId);
    if (info?.inputModalities.includes("image")) {
      return createCompletionModel(envModelId);
    }
  }
  const { models } = await listModels({ outputType: "text" });
  const vision = models
    .filter((model) => model.inputModalities.includes("image"))
    .sort(
      (a, b) => (a.prices.input ?? Number.POSITIVE_INFINITY) - (b.prices.input ?? Number.POSITIVE_INFINITY),
    );
  const pick = vision[0];
  return pick ? createCompletionModel(pick.modelId) : null;
}

/** Convenience factory used by build-run-input (default store wiring). */
export function createDefaultViewImageTool(options: {
  userId: string;
  sessionId: string;
  model: CompletionModel;
}) {
  return createViewImageTool({
    ...options,
    store: getImageStore(),
  });
}
