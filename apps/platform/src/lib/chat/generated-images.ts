import type { UIMessage } from "@anvia/react";

export type CollectedGeneratedImage = {
  imageId: string;
  modelId: string;
  prompt: string;
  width: number;
  height: number;
  mediaType: string;
  index: number;
  total: number;
};

const IMAGE_TOOL_NAMES = new Set(["generate_image", "edit_image"]);

export function isImageToolName(name: string): boolean {
  return IMAGE_TOOL_NAMES.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Tool parts may carry output as a JSON string during/after streaming. */
function parseToolOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Collect unique generated images from completed image tool parts in the
 * session's messages. First appearance wins (a repeated generation keeps its
 * first spot).
 */
export function collectGeneratedImages(
  parts: Array<{
    type?: string;
    state?: string;
    toolName?: string;
    output?: unknown;
  }>,
): CollectedGeneratedImage[] {
  const byImageId = new Map<string, CollectedGeneratedImage>();

  for (const part of parts) {
    if (part.type !== "tool") continue;
    if (!part.toolName || !isImageToolName(part.toolName)) continue;
    if (part.state !== "output-available") continue;

    const parsed = parseToolOutput(part.output);
    const output = isRecord(parsed) ? parsed : {};
    const images = Array.isArray(output.images) ? output.images : [];

    for (const image of images) {
      if (!isRecord(image)) continue;
      const imageId = asString(image.imageId);
      if (!imageId) continue;
      if (byImageId.has(imageId)) continue;

      byImageId.set(imageId, {
        imageId,
        modelId: asString(image.modelId) ?? "",
        prompt: asString(image.prompt) ?? "",
        width: asFiniteNumber(image.width) ?? 0,
        height: asFiniteNumber(image.height) ?? 0,
        mediaType: asString(image.mediaType) ?? "image/png",
        index: asFiniteNumber(image.index) ?? 0,
        total: asFiniteNumber(image.total) ?? 1,
      });
    }
  }

  return [...byImageId.values()];
}

/**
 * Collect generated images across an entire message list (session shape).
 */
export function collectGeneratedImagesFromMessages(
  messages: UIMessage[],
): CollectedGeneratedImage[] {
  return collectGeneratedImages(messages.flatMap((m) => m.parts));
}
