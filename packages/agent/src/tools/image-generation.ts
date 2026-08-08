import { createTool, type AnyTool } from "@anvia/core";
import {
  imageGenerationRequest,
  type GeneratedImage,
  type ImageGenerationModel,
  type ImageGenerationResponse,
} from "@anvia/core/image-generation";
import z from "zod";
import { mapOpenRouterImageError } from "../providers/image-generation.js";

/**
 * generate_image + edit_image agent tools backed by the session's image model.
 * Both tools share one approval gate: when the per-session image toggle is off
 * and no grant was issued for the tool, the run suspends and asks the user to
 * approve with the prompt as justification. Tool overrides (UI-edited params)
 * are consumed via `takeToolOverride` and win over model-supplied args.
 */

const MAX_PROMPT_LENGTH = 4000;
/** Hard cap on images per call when the model capability is unknown. */
const MAX_IMAGES = 4;
/** Upper bound the model may request directly (the execution cap is capability-aware). */
const MAX_MODEL_IMAGES = 10;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

const PROMPT_DESCRIPTION =
  "Describe the image to create in detail — subject, style, composition. " +
  "Longer, more specific prompts produce better results.";

const generateImageInput = z.object({
  prompt: z
    .string()
    .min(3, "Prompt must be at least 3 characters")
    .max(MAX_PROMPT_LENGTH, `Prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
    .describe(PROMPT_DESCRIPTION),
  modelId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The image model to use. Leave unset to use the session default model.",
    ),
  aspectRatio: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Desired output aspect ratio (e.g. 1:1, 16:9, 9:16). Leave unset to use the session default.",
    ),
  quality: z
    .string()
    .min(1)
    .optional()
    .describe("Output quality level. Leave unset to use the session default."),
  background: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Background for the image (e.g. transparent). Leave unset for a model-chosen background.",
    ),
  n: z
    .coerce
    .number()
    .int()
    .min(1)
    .max(MAX_MODEL_IMAGES)
    .optional()
    .describe(
      `How many images to generate (default 1, max ${MAX_MODEL_IMAGES})`,
    ),
});

const editImageInput = z.object({
  prompt: z
    .string()
    .min(3, "Prompt must be at least 3 characters")
    .max(MAX_PROMPT_LENGTH, `Prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
    .describe("Describe the edit to apply to the reference image."),
  referenceImageId: z
    .string()
    .min(1)
    .describe(
      "The id of a previously generated image (returned by generate_image) to edit.",
    ),
  modelId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The image model to use. Leave unset to use the session default model.",
    ),
  aspectRatio: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Desired output aspect ratio (e.g. 1:1, 16:9, 9:16). Leave unset to use the session default.",
    ),
  quality: z
    .string()
    .min(1)
    .optional()
    .describe("Output quality level. Leave unset to use the session default."),
  background: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Background for the edited image (e.g. transparent). Leave unset for a model-chosen background.",
    ),
});

/**
 * Re-validation schema for args AFTER the override merge. Overrides are
 * user-supplied and bypass the framework's validation of the model's args, so
 * the merged object is re-parsed here. `n` is unbounded above because the
 * effective cap (capability nMax, else MAX_IMAGES) is enforced at execution;
 * an upper bound here would reject hostile values instead of capping them.
 */
const generateImageMergedInput = generateImageInput.extend({
  n: z.coerce.number().int().min(1).optional(),
});

export type ImageGenSettings = {
  modelId?: string;
  aspectRatio?: string;
  quality?: string;
  background?: string;
  n?: number;
};

export type GeneratedImageRecord = {
  id: string;
  mediaType: string;
  width: number;
  height: number;
  modelId: string;
  prompt: string;
};

export type ImageCapabilitySet = {
  nMax: number;
  background?: string[];
  aspectRatios?: string[];
  quality?: string[];
};

export type ImageGenerationToolScope = {
  model: ImageGenerationModel<unknown, string>;
  store: {
    saveGeneratedImage(input: {
      userId: string;
      sessionId: string;
      projectId: string | null;
      buffer: Uint8Array;
      mediaType: string | undefined;
      modelId: string;
      prompt: string;
      width: number;
      height: number;
      nOfTotal?: string;
    }): Promise<GeneratedImageRecord>;
  };
  /** Per-session toggle: false → the model must ask the user before generating. */
  enabled: boolean;
  /** True when the user granted the tool for this session without asking again. */
  hasGrant(toolName: string): boolean | Promise<boolean>;
  /** Consume a one-shot override of tool args (UI-edited params), if any. */
  takeToolOverride(
    toolName: string,
  ): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  userId: string;
  sessionId: string;
  projectId: string | null;
  /** Resolve a previously generated image by id; null when not found. */
  resolveReference(imageId: string): Promise<{
    mediaType: string;
    buffer: Uint8Array;
  } | null>;
  /** Capabilities for a model id; null when unknown (allow defaults). */
  capabilities(modelId: string): ImageCapabilitySet | null;
  defaultSettings?: ImageGenSettings;
  /** Max size of an edit reference image in bytes (default 10 MB). */
  maxBytes?: number;
};

export type GeneratedImageMeta = {
  imageId: string;
  mediaType: string;
  width: number;
  height: number;
  modelId: string;
  prompt: string;
  index: number;
  total: number;
};

export type GenerateImageResult = {
  images: GeneratedImageMeta[];
  error?: string;
  errors?: string[];
};

const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:2": { width: 1152, height: 768 },
  "2:3": { width: 768, height: 1152 },
  "4:3": { width: 1152, height: 864 },
  "3:4": { width: 864, height: 1152 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "21:9": { width: 1344, height: 576 },
  "9:19.5": { width: 720, height: 1560 },
  "19.5:9": { width: 1560, height: 720 },
  auto: { width: 1024, height: 1024 },
};

export function aspectRatioToSize(
  aspectRatio?: string,
): { width: number; height: number } {
  return ASPECT_SIZES[aspectRatio ?? "auto"] ?? ASPECT_SIZES.auto!;
}

const OVERRIDE_KEYS = [
  "prompt",
  "modelId",
  "aspectRatio",
  "quality",
  "background",
  "n",
] as const;

type GenerationArgs = {
  prompt: string;
  modelId?: string | undefined;
  aspectRatio?: string | undefined;
  quality?: string | undefined;
  background?: string | undefined;
  n?: number | undefined;
};

type InputReference = {
  type: "image_url";
  image_url: { url: string };
};

function applyOverride(
  args: GenerationArgs,
  override: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return { ...args };
  }
  const merged: Record<string, unknown> = { ...args };
  for (const key of OVERRIDE_KEYS) {
    if (override[key] !== undefined) {
      merged[key] = override[key];
    }
  }
  return merged;
}

/** Keep a value only when the capability set allows it; unknown set = allow. */
function allowedValue(
  requested: string | undefined,
  allowed: string[] | undefined,
  hasCapability: boolean,
): string | undefined {
  if (!requested) return undefined;
  if (!hasCapability) return requested;
  if (!allowed) return undefined;
  return allowed.includes(requested) ? requested : undefined;
}

/** Bounded error message: pass through our own errors, map status objects. */
function boundedImageError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return mapOpenRouterImageError(error);
}

async function runGeneration(
  scope: ImageGenerationToolScope,
  args: GenerationArgs,
  isEdit: boolean,
  extraParams: Record<string, unknown> = {},
): Promise<GenerateImageResult> {
  const toolName = isEdit ? "edit_image" : "generate_image";
  const mergedInput = applyOverride(args, await scope.takeToolOverride(toolName));
  // Overrides bypass the framework's validation of the model's args, so the
  // merged args are re-validated against the tool schema. When an override is
  // invalid (e.g. a prompt beyond the bound), it is dropped in favor of the
  // pre-override args, which were already validated — never forwarded raw.
  const schema = isEdit ? editImageInput : generateImageMergedInput;
  const parsed = schema.safeParse(mergedInput);
  const merged: GenerationArgs = parsed.success
    ? (parsed.data as GenerationArgs)
    : args;

  const resolvedModelId: string | undefined =
    merged.modelId ?? scope.defaultSettings?.modelId ?? scope.model.defaultModel;
  const capability = resolvedModelId ? scope.capabilities(resolvedModelId) : null;
  const hasCapability = capability !== null;

  const quality = allowedValue(
    merged.quality ?? scope.defaultSettings?.quality,
    capability?.quality,
    hasCapability,
  );
  const background = allowedValue(
    merged.background ?? scope.defaultSettings?.background,
    capability?.background,
    hasCapability,
  );
  const requestedN = merged.n ?? scope.defaultSettings?.n;
  const n =
    requestedN !== undefined
      ? Math.max(1, Math.min(requestedN, capability?.nMax ?? MAX_IMAGES))
      : undefined;

  const { width, height } = aspectRatioToSize(
    merged.aspectRatio ?? scope.defaultSettings?.aspectRatio,
  );

  const additionalParams = {
    // Only send a model id we actually resolved; otherwise the provider uses
    // its own default model.
    ...(resolvedModelId ? { model: resolvedModelId } : {}),
    ...(quality ? { quality } : {}),
    ...(background ? { background, output_format: "png" } : {}),
    ...(n !== undefined ? { n } : {}),
    ...extraParams,
  };

  let response: ImageGenerationResponse<unknown>;
  try {
    response = await imageGenerationRequest(scope.model)
      .prompt(merged.prompt)
      .width(width)
      .height(height)
      .additionalParams(additionalParams)
      .send();
  } catch (error) {
    return { images: [], error: boundedImageError(error) };
  }

  const total = response.images.length;
  const images: GeneratedImageMeta[] = [];
  const errors: string[] = [];

  for (let index = 0; index < total; index++) {
    const image = response.images[index] as GeneratedImage;
    try {
      const saved = await scope.store.saveGeneratedImage({
        userId: scope.userId,
        sessionId: scope.sessionId,
        projectId: scope.projectId,
        buffer: image.data,
        mediaType: image.mediaType,
        modelId: resolvedModelId ?? "",
        prompt: merged.prompt,
        width,
        height,
        ...(total > 1 ? { nOfTotal: `${index + 1} of ${total}` } : {}),
      });
      images.push({
        imageId: saved.id,
        mediaType: saved.mediaType,
        width: saved.width,
        height: saved.height,
        modelId: saved.modelId,
        prompt: saved.prompt,
        index,
        total,
      });
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : "Failed to save the generated image",
      );
    }
  }

  return {
    images,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function createImageGenerationTools(
  scope: ImageGenerationToolScope,
): AnyTool[] {
  const approval = (toolName: "generate_image" | "edit_image") => ({
    when: async () => !scope.enabled && !(await scope.hasGrant(toolName)),
    // The reason shows the model's pre-execution intent. An override replacing
    // the prompt comes from the user's own approval card, so it is not shown
    // here; override prompts are still bounded by schema re-validation in
    // runGeneration, so the mismatch cannot grow unbounded.
    reason: (ctx: { args: { prompt: string } }) =>
      `The agent wants to generate an image: "${ctx.args.prompt.slice(0, 200)}"`,
    rejectMessage: "Image generation was declined by the user.",
  });

  return [
    createTool({
      name: "generate_image",
      description:
        "Generate an image from a text prompt using the configured image model. " +
        "Use when the user asks to create, draw, or imagine an image; to edit an " +
        "existing generated image, use edit_image instead. Only set modelId, " +
        "aspectRatio, quality, background, or n when the user explicitly asks — " +
        "otherwise leave them unset to use session defaults. Generation may " +
        "require user approval, and the tool returns image ids, not image data.",
      input: generateImageInput,
      approval: approval("generate_image"),
      execute: async (args: GenerationArgs) => runGeneration(scope, args, false),
    }),
    createTool({
      name: "edit_image",
      description:
        "Edit or transform an existing generated image, referenced by the image id " +
        "returned from a previous generate_image call. Describe the edit precisely " +
        "and only set modelId, aspectRatio, quality, or background when the user " +
        "explicitly asks — otherwise leave them unset to use session defaults. " +
        "Generation may require user approval, and the tool returns image ids, " +
        "not image data.",
      input: editImageInput,
      approval: approval("edit_image"),
      execute: async (args) => {
        const reference = await scope.resolveReference(args.referenceImageId);
        if (!reference) {
          return { images: [], error: "Reference image not found" };
        }
        if (reference.buffer.byteLength > (scope.maxBytes ?? MAX_REFERENCE_BYTES)) {
          return { images: [], error: "Reference image too large" };
        }
        const dataUrl = `data:${reference.mediaType ?? "application/octet-stream"};base64,${Buffer.from(reference.buffer).toString("base64")}`;
        const inputReferences: InputReference[] = [
          { type: "image_url", image_url: { url: dataUrl } },
        ];
        return runGeneration(scope, args, true, {
          input_references: inputReferences,
        });
      },
    }),
  ];
}

/** Agent guidance on when to use image tools (added to instructions). */
export const IMAGE_GENERATION_INSTRUCTION = [
  "You can generate and edit images with the generate_image and edit_image tools.",
  "When the prompt needs visual detail the model cannot reliably imagine — a real place, product, person, or layout — run web_search first to gather accurate visual references.",
  "Use the session defaults for model, aspect ratio, quality, and background unless the user explicitly asks for different values.",
  "When the request is ambiguous about style, aspect ratio, or subject matter, call request_clarification instead of guessing.",
  "When a generation succeeds, report the returned image ids to the user.",
  "Image generation may require user approval; proceed only after the tool returns its result, and respect a decline.",
].join("\n");
