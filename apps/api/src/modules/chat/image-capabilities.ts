import type { ImageCapabilitySet } from "@assingment/agent";

/** Capability set for a model with unknown capabilities (tool-side default). */
const DEFAULT_IMAGE_CAPABILITY: ImageCapabilitySet = { nMax: 4 };

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length > 0 ? strings : undefined;
}

/**
 * Parse a ChatModel.imageCapabilities Json row into the image-tool capability
 * shape: { aspectRatios, quality?, n: {min,max}, background?, resolutions?, sizes? }.
 * Unknown/malformed rows fall back to the tool's default (nMax 4).
 */
export function parseImageCapabilities(raw: unknown): ImageCapabilitySet {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_IMAGE_CAPABILITY;
  }
  const record = raw as Record<string, unknown>;
  const n =
    record.n && typeof record.n === "object" && !Array.isArray(record.n)
      ? (record.n as Record<string, unknown>)
      : null;
  const nMax =
    n && typeof n.max === "number" && Number.isFinite(n.max)
      ? Math.max(1, Math.floor(n.max))
      : DEFAULT_IMAGE_CAPABILITY.nMax;

  const background = stringArray(record.background);
  const aspectRatios = stringArray(record.aspectRatios);
  const quality = stringArray(record.quality);
  const resolutions = stringArray(record.resolutions);
  const sizes = stringArray(record.sizes);

  return {
    nMax,
    ...(background ? { background } : {}),
    ...(aspectRatios ? { aspectRatios } : {}),
    ...(quality ? { quality } : {}),
    ...(resolutions ? { resolutions } : {}),
    ...(sizes ? { sizes } : {}),
  };
}
