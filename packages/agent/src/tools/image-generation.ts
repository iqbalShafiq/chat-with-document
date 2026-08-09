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
  resolutions?: string[];
  /**
   * Explicit pixel sizes the model accepts (OpenAI-style). When present the
   * tool sends `size: "WxH"`; otherwise it sends `aspect_ratio` +
   * `resolution` (Gemini/Grok-style).
   */
  sizes?: string[];
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

/**
 * Pixel sizes per aspect ratio for OpenAI-style models. These are sent as
 * `size` and MUST match a model's accepted list — the tool validates against
 * the model's `sizes` capability and falls back to "auto" when a ratio is
 * not available, so the request is never rejected with an invalid size.
 */
const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:2": { width: 1536, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
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

/**
 * Metadata dimensions for a stored image. The canonical aspect map is used
 * as the record (the provider response carries no explicit dimensions).
 */
function savedWidth(_image: GeneratedImage, fallback: number): number {
  return fallback;
}

function savedHeight(_image: GeneratedImage, fallback: number): number {
  return fallback;
}

/**
 * Resolve the wire parameters for the generation request:
 * - OpenAI-style models (`sizes` capability): pick the closest accepted
 *   `size` for the requested aspect ratio, falling back to "auto".
 * - Gemini/Grok-style models: no `size` — send `aspect_ratio` +
 *   `resolution` instead (verified against OpenRouter discovery 2026-08-09).
 */
export function resolveImageRequestParams(
  aspectRatio: string | undefined,
  capability: ImageCapabilitySet | null,
): { size?: string; aspectRatio?: string; resolution?: string } {
  const ratio = aspectRatio ?? "auto";

  if (capability?.sizes && capability.sizes.length > 0) {
    const { width, height } = aspectRatioToSize(ratio);
    const exact = `${width}x${height}`;
    if (capability.sizes.includes(exact)) return { size: exact };
    if (capability.sizes.includes("auto")) return { size: "auto" };
    return { size: capability.sizes[0]! };
  }

  if (capability?.resolutions && capability.resolutions.length > 0) {
    return {
      aspectRatio: ratio,
      resolution: capability.resolutions[0]!,
    };
  }

  // Unknown capability set — fall back to the explicit size path.
  const { width, height } = aspectRatioToSize(ratio);
  return { size: `${width}x${height}` };
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

/**
 * Fail-safe grant read: a registry blip must not fail the run — it only
 * makes approval required for this call (the safe default).
 */
async function safeHasGrant(
  scope: ImageGenerationToolScope,
  toolName: string,
): Promise<boolean> {
  try {
    return await scope.hasGrant(toolName);
  } catch (error) {
    console.error("[image-tools] hasGrant failed, requiring approval", {
      toolName,
      error,
    });
    return false;
  }
}

/**
 * Fail-safe override read: a registry blip must not fail the run — the call
 * proceeds with the model-supplied args.
 */
async function safeTakeToolOverride(
  scope: ImageGenerationToolScope,
  toolName: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await scope.takeToolOverride(toolName);
  } catch (error) {
    console.error("[image-tools] takeToolOverride failed, ignoring override", {
      toolName,
      error,
    });
    return null;
  }
}

async function runGeneration(
  scope: ImageGenerationToolScope,
  args: GenerationArgs,
  isEdit: boolean,
  extraParams: Record<string, unknown> = {},
): Promise<GenerateImageResult> {
  const toolName = isEdit ? "edit_image" : "generate_image";
  const mergedInput = applyOverride(
    args,
    await safeTakeToolOverride(scope, toolName),
  );
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

  // Size semantics depend on the model family: OpenAI models take an exact
  // `size`; Gemini/Grok take `aspect_ratio` + `resolution`. The request params
  // are resolved per model capability so the wire payload is never rejected
  // with an unsupported size.
  const { size, aspectRatio: wireAspectRatio, resolution } =
    resolveImageRequestParams(
      merged.aspectRatio ?? scope.defaultSettings?.aspectRatio,
      capability,
    );
  // Metadata dimensions: aspect-ratio models still report the requested
  // ratio's canonical pixels (best effort for the DB row / gallery).
  const { width, height } = aspectRatioToSize(
    merged.aspectRatio ?? scope.defaultSettings?.aspectRatio,
  );

  const additionalParams = {
    // Only send a model id we actually resolved; otherwise the provider uses
    // its own default model.
    ...(resolvedModelId ? { model: resolvedModelId } : {}),
    ...(size ? { size } : {}),
    ...(wireAspectRatio ? { aspect_ratio: wireAspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
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
        width: savedWidth(image, width),
        height: savedHeight(image, height),
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
    when: async () => !scope.enabled && !(await safeHasGrant(scope, toolName)),
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

/**
 * Agent guidance on when to use image tools. The web_search-first sentence
 * is only included when web tools are actually registered — the model must
 * not be told to run a tool that does not exist.
 */
export function buildImageGenerationInstruction(input: {
  webSearchAvailable: boolean;
}): string {
  return [
    "You can generate and edit images with the generate_image and edit_image tools.",
    ...(input.webSearchAvailable
      ? [
          "When the prompt needs visual detail the model cannot reliably imagine — a real place, product, person, or layout — run web_search first to gather accurate visual references.",
        ]
      : []),
    "Use the session defaults for model, aspect ratio, quality, and background unless the user explicitly asks for different values.",
    "When the request is ambiguous about style, aspect ratio, or subject matter, call request_clarification instead of guessing.",
    "When a generation succeeds, report the returned image ids to the user.",
    "Image generation may require user approval; proceed only after the tool returns its result, and respect a decline.",
  ].join("\n");
}

/** Default image-generation instruction (web search available). */
export const IMAGE_GENERATION_INSTRUCTION = buildImageGenerationInstruction({
  webSearchAvailable: true,
});
