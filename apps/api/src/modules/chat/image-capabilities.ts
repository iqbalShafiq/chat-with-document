import type { ImageCapabilitySet } from "@anreal/agent";

const CAPABILITY_KEYS = new Set([
  "n",
  "background",
  "aspectRatios",
  "quality",
  "resolutions",
  "sizes",
]);

export class ImageCapabilityCatalogError extends Error {
  readonly code = "IMAGE_CAPABILITY_CATALOG_INVALID" as const;

  constructor() {
    super("image capability catalog is invalid");
    this.name = "ImageCapabilityCatalogError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredStringArray(
  record: Record<string, unknown>,
  key: "aspectRatios" | "sizes" | "resolutions",
): string[] | null {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) return null;
  if (
    value.some(
      (item) => typeof item !== "string" || item.trim().length === 0,
    )
  ) {
    throw new ImageCapabilityCatalogError();
  }
  return value as string[];
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: "background" | "quality",
): string[] | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ImageCapabilityCatalogError();
  }
  if (
    value.some(
      (item) => typeof item !== "string" || item.trim().length === 0,
    )
  ) {
    throw new ImageCapabilityCatalogError();
  }
  return value as string[];
}

/**
 * Parse the authoritative ChatModel.imageCapabilities JSON row.
 *
 * Image generation has no safe provider/default fallback: a missing or
 * malformed catalog is a configuration error and stops recipe construction.
 */
export function parseImageCapabilities(raw: unknown): ImageCapabilitySet {
  if (!isRecord(raw)) throw new ImageCapabilityCatalogError();
  if (Object.keys(raw).some((key) => !CAPABILITY_KEYS.has(key))) {
    throw new ImageCapabilityCatalogError();
  }

  const n = raw.n;
  if (!isRecord(n)) throw new ImageCapabilityCatalogError();
  const min = n.min;
  const max = n.max;
  if (
    typeof min !== "number" ||
    !Number.isSafeInteger(min) ||
    min !== 1 ||
    typeof max !== "number" ||
    !Number.isSafeInteger(max) ||
    max < min ||
    max > 100
  ) {
    throw new ImageCapabilityCatalogError();
  }

  const aspectRatios = requiredStringArray(raw, "aspectRatios");
  const sizes = requiredStringArray(raw, "sizes");
  const resolutions = requiredStringArray(raw, "resolutions");
  if (!aspectRatios || (sizes && resolutions) || (!sizes && !resolutions)) {
    throw new ImageCapabilityCatalogError();
  }

  const background = optionalStringArray(raw, "background");
  const quality = optionalStringArray(raw, "quality");

  return {
    nMax: max,
    aspectRatios,
    ...(background ? { background } : {}),
    ...(quality ? { quality } : {}),
    ...(resolutions ? { resolutions } : {}),
    ...(sizes ? { sizes } : {}),
  };
}
