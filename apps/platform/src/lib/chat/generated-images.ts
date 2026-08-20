import type { UIMessage } from "@anvia/react";
import type { GeneratedImageMeta } from "#/lib/api";

export type CollectedGeneratedImage = {
  imageId: string;
  modelId: string;
  prompt: string;
  width: number;
  height: number;
  mediaType: string;
  index: number;
  total: number;
  source: string;
  sourceUrl: string | null;
};

/**
 * Unified gallery/rail shape for generated images — one row per image across
 * live tool parts and server history, keyed by the stored image id.
 */
export type GeneratedImageItem = {
  id: string;
  modelId: string;
  prompt: string;
  width: number;
  height: number;
  mediaType: string;
  nOfTotal: string | null;
  source: string;
  sourceUrl: string | null;
};

const IMAGE_TOOL_NAMES = new Set(["generate_image", "edit_image"]);

export function isImageToolName(name: string): boolean {
  return IMAGE_TOOL_NAMES.has(name);
}

/**
 * Image tools that render into the message rail/gallery, including view_image
 * (web photos) alongside the generative image tools.
 */
export function isMessageImageToolName(name: string): boolean {
  return isImageToolName(name) || name === "view_image";
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
    if (!part.toolName || !isMessageImageToolName(part.toolName)) continue;
    if (part.state !== "output-available") continue;

    const parsed = parseToolOutput(part.output);

    let rawImages: unknown[] = [];
    if (part.toolName === "view_image") {
      if (Array.isArray(parsed)) {
        const textPart = parsed.find(
          (p): p is { type: "text"; text: string } =>
            isRecord(p) && p.type === "text" && typeof p.text === "string",
        );
        if (textPart) {
          try {
            const json = JSON.parse(textPart.text) as unknown;
            if (isRecord(json) && Array.isArray(json.images)) {
              rawImages = json.images;
            }
          } catch {
            // malformed — ignore
          }
        }
      } else if (isRecord(parsed) && Array.isArray(parsed.images)) {
        rawImages = parsed.images;
      }
    } else {
      rawImages =
        isRecord(parsed) && Array.isArray(parsed.images) ? parsed.images : [];
    }

    for (const image of rawImages) {
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
        source: asString(image.source) ?? "generated",
        sourceUrl: asString(image.sourceUrl),
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

function toItem(
  image: CollectedGeneratedImage | GeneratedImageMeta,
): GeneratedImageItem {
  if ("imageId" in image) {
    return {
      id: image.imageId,
      modelId: image.modelId,
      prompt: image.prompt,
      width: image.width,
      height: image.height,
      mediaType: image.mediaType,
      nOfTotal:
        image.total > 1 ? `${image.index + 1} of ${image.total}` : null,
      source: image.source,
      sourceUrl: image.sourceUrl,
    };
  }
  return {
    id: image.id,
    modelId: image.modelId,
    prompt: image.prompt,
    width: image.width,
    height: image.height,
    mediaType: image.mediaType,
    nOfTotal: image.nOfTotal,
    source: image.source,
    sourceUrl: image.sourceUrl,
  };
}

/** Normalize a live or persisted image record to the shared rail/gallery shape. */
export function toGeneratedImageItem(
  image: CollectedGeneratedImage | GeneratedImageMeta,
): GeneratedImageItem {
  return toItem(image);
}

/**
 * Images produced by a single tool part (generate_image / edit_image with a
 * completed output) — used to render the result inline in the chat message.
 */
export function imageItemsFromToolPart(
  part: {
    type?: string;
    state?: string;
    toolName?: string;
    output?: unknown;
  },
): GeneratedImageItem[] {
  return collectGeneratedImages([part]).map(toGeneratedImageItem);
}

/**
 * Group consecutive image tool parts into runs. A multi-image generation
 * (n > 1) or repeated generate/edit calls with no text between them render
 * as one horizontal strip instead of separate grids.
 */
export function groupImageToolRuns<T extends { type?: string; toolName?: string }>(
  parts: T[],
): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  for (const part of parts) {
    if (part.type === "tool" && isMessageImageToolName(part.toolName ?? "")) {
      current.push(part);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Merge live stream images (first) with persisted history, deduped by id.
 * Live items keep their slot; history fills in anything the stream lost.
 */
export function mergeGeneratedImages(
  live: CollectedGeneratedImage[],
  history: GeneratedImageMeta[],
): GeneratedImageItem[] {
  const byId = new Map<string, GeneratedImageItem>();
  for (const image of [...live, ...history]) {
    const item = toItem(image);
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * Count distinct image tool parts still running (input-streaming /
 * input-available) — drives the in-flight shimmer tiles in the rail.
 */
export function countRunningImageToolParts(
  parts: Array<{ id?: string; type?: string; state?: string; toolName?: string }>,
): number {
  const runningIds = new Set<string>();
  for (const part of parts) {
    if (part.type !== "tool") continue;
    if (!part.toolName || !isMessageImageToolName(part.toolName)) continue;
    if (part.state === "output-available" || part.state === "error") continue;
    runningIds.add(part.id ?? part.toolName);
  }
  return runningIds.size;
}

export function countRunningImageToolPartsFromMessages(
  messages: UIMessage[],
): number {
  return countRunningImageToolParts(messages.flatMap((m) => m.parts));
}
