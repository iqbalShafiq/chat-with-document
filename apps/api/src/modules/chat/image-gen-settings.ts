import z from "zod";
import type { ImageGenSettings } from "@assingment/agent";

/**
 * Client-supplied image generation defaults for a run: model, aspect ratio,
 * quality, background, count. All optional — unset fields fall back to the
 * model/session defaults inside the image tools.
 */
export const imageGenSettingsSchema = z.object({
  modelId: z.string().min(1).optional(),
  aspectRatio: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  background: z.string().min(1).optional(),
  n: z.number().int().min(1).max(10).optional(),
});

/** Parse a raw request body field; null when absent, non-object, or invalid. */
export function parseImageGenSettings(
  value: unknown,
): ImageGenSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = imageGenSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
