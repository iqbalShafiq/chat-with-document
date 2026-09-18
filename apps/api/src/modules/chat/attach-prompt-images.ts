import type {
  CompletionRequest,
  UserContentPart,
  UserMessage,
} from "@anvia/core/completion";
import type { AttachedRemoteImage } from "@anreal/agent";

/**
 * Prepend pinned session-image bytes onto a user prompt so a vision model
 * sees them natively instead of having to call view_image.
 */
export function prependPromptImages(
  prompt: UserMessage,
  parts: readonly UserContentPart[],
): UserMessage {
  if (parts.length === 0) return prompt;
  const existing: UserContentPart[] =
    typeof prompt.content === "string"
      ? [{ type: "text", text: prompt.content }]
      : [...prompt.content];
  return { ...prompt, content: [...parts, ...existing] };
}

export async function loadActiveContextImageParts(input: {
  images: readonly { r2Key: string; mediaType: string }[];
  fetchBuffer: (r2Key: string) => Promise<Uint8Array>;
}): Promise<UserContentPart[]> {
  const parts: UserContentPart[] = [];
  for (const image of input.images) {
    try {
      const buffer = await input.fetchBuffer(image.r2Key);
      if (buffer.byteLength === 0) continue;
      parts.push({
        type: "image",
        image: { type: "data", data: Buffer.from(buffer).toString("base64") },
        mediaType: image.mediaType,
        detail: "auto",
      });
    } catch (error) {
      console.error("[chat] active context image load failed", {
        r2Key: image.r2Key,
        error,
      });
    }
  }
  return parts;
}

const VISION_WEB_IMAGE_NOTE =
  "Reference images from the latest web_search or web_fetch. Inspect these pixels.";

/** Buffer fetched web images so they can be injected on the next model turn. */
export function createPendingVisionImageBuffer() {
  const parts: UserContentPart[] = [];
  return {
    push(images: readonly AttachedRemoteImage[]) {
      for (const image of images) {
        if (!image.data.trim()) continue;
        parts.push({
          type: "image",
          image: { type: "data", data: image.data },
          mediaType: image.mediaType,
          detail: "auto",
        });
      }
    },
    consume(): UserContentPart[] {
      return parts.splice(0);
    },
  };
}

export function injectPendingVisionImages(
  request: CompletionRequest,
  images: readonly UserContentPart[],
): CompletionRequest {
  if (images.length === 0) return request;
  return {
    ...request,
    chatHistory: [
      ...request.chatHistory,
      {
        role: "user",
        content: [{ type: "text", text: VISION_WEB_IMAGE_NOTE }, ...images],
      },
    ],
  };
}
