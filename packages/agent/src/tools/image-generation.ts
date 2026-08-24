import {
  createTool,
  type AnyTool,
  type JsonObject,
  type ToolCallContext,
} from "@anvia/core";
import {
  generateImage,
  type GeneratedImage,
  type ImageGenerationModel,
  type ImageGenerationResult,
} from "@anvia/core/image-generation";
import z from "zod";
import { mapOpenRouterImageError } from "../providers/image-generation.js";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

/**
 * generate_image + edit_image agent tools backed by the session's image model.
 * Both tools share one approval gate: when the per-session image toggle is off
 * and no grant was issued for the tool, the run suspends and asks the user to
 * approve with the prompt as justification. Tool overrides (UI-edited params)
 * are consumed via `takeToolOverride` and win over model-supplied args.
 */

const MAX_PROMPT_LENGTH = 4000;
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
}).strict();

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
}).strict();

const generateImageSpec = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt using the configured image model. " +
    "Use when the user asks to create, draw, or imagine an image; to edit an " +
    "existing generated image, use edit_image instead. Only set modelId, " +
    "aspectRatio, quality, background, or n when the user explicitly asks — " +
    "otherwise leave them unset to use session defaults. Generation may " +
    "require user approval, and the tool returns image ids, not image data.",
  inputSchema: generateImageInput,
} as const;
const editImageSpec = {
  name: "edit_image",
  description:
    "Edit or transform an existing generated image, referenced by the image id " +
    "returned from a previous generate_image call. Describe the edit precisely " +
    "and only set modelId, aspectRatio, quality, or background when the user " +
    "explicitly asks — otherwise leave them unset to use session defaults. " +
    "Generation may require user approval, and the tool returns image ids, " +
    "not image data.",
  inputSchema: editImageInput,
} as const;

export const IMAGE_GENERATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(generateImageSpec),
  createStaticToolDefinition(editImageSpec),
];

/**
 * Re-validation schema for args AFTER the override merge. Overrides are
 * user-supplied and bypass the framework's validation of the model's args, so
 * the merged object is re-parsed here. Invalid or out-of-range values are
 * rejected; execution then enforces the stricter authoritative model cap.
 */
const generateImageMergedInput = generateImageInput.extend({
  n: z.number().int().min(1).max(MAX_MODEL_IMAGES).optional(),
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

export class ImageCapabilityConfigurationError extends Error {
  readonly code = "IMAGE_CAPABILITY_CONFIGURATION_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "ImageCapabilityConfigurationError";
  }
}

export type ImageGenerationToolScope = {
  model: ImageGenerationModel<unknown>;
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
  if (aspectRatio === undefined) {
    throw new ImageCapabilityConfigurationError("Image aspect ratio is required");
  }
  const dimensions = ASPECT_SIZES[aspectRatio];
  if (!dimensions) {
    throw new ImageCapabilityConfigurationError(
      "Image aspect ratio is not supported",
    );
  }
  return dimensions;
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
 * - OpenAI-style models (`sizes` capability): pick the exact accepted
 *   `size` for the requested aspect ratio.
 * - Gemini/Grok-style models: no `size` — send `aspect_ratio` +
 *   `resolution` instead (verified against OpenRouter discovery 2026-08-09).
 */
export function resolveImageRequestParams(
  aspectRatio: string | undefined,
  capability: ImageCapabilitySet | null,
): { size?: string; aspectRatio?: string; resolution?: string } {
  const validCapability = validateImageCapability(capability);
  if (aspectRatio === undefined) {
    throw new ImageCapabilityConfigurationError("Image aspect ratio is required");
  }
  const ratio = aspectRatio;
  if (!validCapability.aspectRatios!.includes(ratio)) {
    throw new ImageCapabilityConfigurationError(
      "Image aspect ratio is not supported",
    );
  }

  if (validCapability.sizes) {
    const { width, height } = aspectRatioToSize(ratio);
    const exact = `${width}x${height}`;
    if (validCapability.sizes.includes(exact)) return { size: exact };
    throw new ImageCapabilityConfigurationError(
      "Image model does not support the requested aspect ratio",
    );
  }

  if (validCapability.resolutions) {
    return {
      aspectRatio: ratio,
      resolution: validCapability.resolutions[0]!,
    };
  }

  throw new ImageCapabilityConfigurationError(
    "Image model capabilities are unavailable",
  );
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
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return { ok: true, value: { ...args } };
  }
  const keys = Object.keys(override);
  if (keys.some((key) => !(OVERRIDE_KEYS as readonly string[]).includes(key))) {
    return { ok: false };
  }
  const merged: Record<string, unknown> = { ...args };
  for (const key of OVERRIDE_KEYS) {
    if (override[key] !== undefined) {
      merged[key] = override[key];
    }
  }
  return { ok: true, value: merged };
}

function validateImageCapability(
  capability: ImageCapabilitySet | null,
): ImageCapabilitySet {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw new ImageCapabilityConfigurationError(
      "Image model capabilities are unavailable",
    );
  }
  if (
    !Number.isSafeInteger(capability.nMax) ||
    capability.nMax < 1 ||
    capability.nMax > MAX_MODEL_IMAGES ||
    !Array.isArray(capability.aspectRatios) ||
    capability.aspectRatios.length === 0
  ) {
    throw new ImageCapabilityConfigurationError(
      "Image model capabilities are unavailable",
    );
  }
  const arrays = [
    capability.aspectRatios,
    capability.sizes,
    capability.resolutions,
    capability.quality,
    capability.background,
  ];
  if (
    arrays.some(
      (values) =>
        values !== undefined &&
        (!Array.isArray(values) ||
          values.length === 0 ||
          values.some(
            (value) => typeof value !== "string" || value.trim().length === 0,
          )),
    ) ||
    (Boolean(capability.sizes) === Boolean(capability.resolutions))
  ) {
    throw new ImageCapabilityConfigurationError(
      "Image model capabilities are unavailable",
    );
  }
  return capability;
}

function supportedValue(
  label: string,
  requested: string | undefined,
  allowed: string[] | undefined,
): string | undefined {
  if (requested === undefined) return undefined;
  if (!allowed || !allowed.includes(requested)) {
    throw new ImageCapabilityConfigurationError(
      `Image ${label} is not supported`,
    );
  }
  return requested;
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
 * Registry override reads are part of the authoritative approval protocol. A
 * read failure must stop this call; proceeding with stale/model args could
 * bypass the user's edited approval policy.
 */
async function safeTakeToolOverride(
  scope: ImageGenerationToolScope,
  toolName: string,
): Promise<{ ok: true; value: Record<string, unknown> | null } | { ok: false }> {
  try {
    return { ok: true, value: await scope.takeToolOverride(toolName) };
  } catch (error) {
    console.error("[image-tools] takeToolOverride unavailable", {
      toolName,
      error,
    });
    return { ok: false };
  }
}

async function runGeneration(
  scope: ImageGenerationToolScope,
  args: GenerationArgs,
  isEdit: boolean,
  extraParams: JsonObject = {},
  context?: ToolCallContext,
): Promise<GenerateImageResult> {
  const toolName = isEdit ? "edit_image" : "generate_image";
  const overrideResult = await safeTakeToolOverride(scope, toolName);
  if (!overrideResult.ok) {
    return {
      images: [],
      error: "Image generation settings are unavailable",
    };
  }
  const mergedResult = applyOverride(args, overrideResult.value);
  if (!mergedResult.ok) {
    return { images: [], error: "Image generation settings are invalid" };
  }
  const mergedInput = mergedResult.value;
  // Overrides bypass the framework's validation of the model's args, so the
  // merged args are re-validated against the tool schema. Invalid registry
  // data is surfaced instead of silently falling back to the original args.
  const schema = isEdit ? editImageInput : generateImageMergedInput;
  const parsed = schema.safeParse(mergedInput);
  if (!parsed.success) {
    return { images: [], error: "Image generation settings are invalid" };
  }
  const merged = parsed.data as GenerationArgs;

  const resolvedModelId: string | undefined =
    merged.modelId ?? scope.defaultSettings?.modelId;
  if (!resolvedModelId) {
    return { images: [], error: "Image model is not configured" };
  }

  let capability: ImageCapabilitySet;
  try {
    capability = validateImageCapability(scope.capabilities(resolvedModelId));
  } catch (error) {
    return {
      images: [],
      error:
        error instanceof ImageCapabilityConfigurationError
          ? error.message
          : "Image model capabilities are unavailable",
    };
  }

  let quality: string | undefined;
  let background: string | undefined;
  let n: number | undefined;
  let size: string | undefined;
  let wireAspectRatio: string | undefined;
  let resolution: string | undefined;
  let width: number;
  let height: number;
  try {
    quality = supportedValue(
      "quality",
      merged.quality ?? scope.defaultSettings?.quality,
      capability.quality,
    );
    background = supportedValue(
      "background",
      merged.background ?? scope.defaultSettings?.background,
      capability.background,
    );
    const requestedN = merged.n ?? scope.defaultSettings?.n;
    if (requestedN !== undefined) {
      if (
        !Number.isSafeInteger(requestedN) ||
        requestedN < 1 ||
        requestedN > capability.nMax
      ) {
        throw new ImageCapabilityConfigurationError(
          "Image count exceeds model capability",
        );
      }
      n = requestedN;
    }

    ({ size, aspectRatio: wireAspectRatio, resolution } =
      resolveImageRequestParams(
        merged.aspectRatio ?? scope.defaultSettings?.aspectRatio,
        capability,
      ));
    ({ width, height } = aspectRatioToSize(
      merged.aspectRatio ?? scope.defaultSettings?.aspectRatio,
    ));
  } catch (error) {
    return {
      images: [],
      error:
        error instanceof ImageCapabilityConfigurationError
          ? error.message
          : "Image model capabilities are unavailable",
    };
  }

  const additionalParams = {
    model: resolvedModelId,
    ...(size ? { size } : {}),
    ...(wireAspectRatio ? { aspect_ratio: wireAspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(quality ? { quality } : {}),
    ...(background ? { background, output_format: "png" } : {}),
    ...(n !== undefined ? { n } : {}),
    ...extraParams,
  };

  let response: ImageGenerationResult<unknown>;
  try {
    response = await generateImage({
      model: scope.model,
      prompt: merged.prompt,
      width,
      height,
      providerOptions: additionalParams,
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
    });
  } catch (error) {
    if (
      context?.abortSignal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
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
        modelId: resolvedModelId,
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
  const requiresApproval = (toolName: "generate_image" | "edit_image") =>
    async (args: { prompt: string }, _context: unknown) => {
      if (scope.enabled || (await safeHasGrant(scope, toolName))) return false;
    // The reason shows the model's pre-execution intent. An override replacing
    // the prompt comes from the user's own approval card, so it is not shown
    // here; override prompts are still bounded by schema re-validation in
    // runGeneration, so the mismatch cannot grow unbounded.
      return {
        reason: `The agent wants to generate an image: "${args.prompt.slice(0, 200)}"`,
      };
    };

  return [
    createTool({
      ...generateImageSpec,
      outputSchema: z.json(),
      requiresApproval: requiresApproval("generate_image"),
      execute: async (args: GenerationArgs, context) =>
        runGeneration(scope, args, false, {}, context),
    }),
    createTool({
      ...editImageSpec,
      outputSchema: z.json(),
      requiresApproval: requiresApproval("edit_image"),
      execute: async (args, context) => {
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
        }, context);
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
