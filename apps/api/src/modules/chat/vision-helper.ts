import { createTool } from "@anvia/core";
import {
  createCompletion,
  Message,
  UserContent,
  type CompletionModel,
} from "@anvia/core/completion";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import {
  getImageStore,
  type ImageStore,
} from "../images/service.js";
import { findActiveModel, listModels } from "../models/service.js";

/** Max bytes we'll download for an external image (8 MiB). */
export const VIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export const VISION_HELPER_INSTRUCTION =
  "Your model cannot receive image input directly. When you need to see what " +
  "an image actually looks like, call view_image — it returns an accurate " +
  "text description of the real pixels via a vision model.\n" +
  "Sources you can pass:\n" +
  "- imageId: a session image id from the active image context or session history, " +
  "or an image id returned by get_document_page_images (document charts, photos, diagrams)\n" +
  "- url: a public http(s) image URL (e.g. a logo or product photo from web_search / web_fetch)\n" +
  "get_document_page_images returns image metadata without the actual pixels " +
  "for your model; when the answer depends on visual content, pass the returned " +
  "image id to view_image to see it.\n" +
  "Prefer view_image over guessing visual details. External reference images " +
  "from the web are supported — do not assume view_image is limited to " +
  "conversation-only images.";

const VIEW_IMAGE_DESCRIPTION =
  "Describe what an image actually shows (via a vision model). Use for " +
  "session images (imageId from active context / history), document page " +
  "images (imageId from get_document_page_images), OR public image " +
  "URLs found on the web (logo, product photo, screenshot, etc.). Required " +
  "when your model cannot receive image input and the answer depends on " +
  "visual content.";

const VIEW_IMAGE_INSTRUCTIONS =
  "Describe the image accurately and concisely, focusing on what is visible: " +
  "subjects, composition, style, colors, and any text. Answer the user's " +
  "question if one is given. Do not speculate about content you cannot see.";

const viewImageInput = z
  .object({
    imageId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Session generated/uploaded image id from the active image context " +
          "or session history, or an image id returned by " +
          "get_document_page_images. Use this for conversation or document images.",
      ),
    url: z
      .string()
      .url()
      .optional()
      .describe(
        "Public http(s) URL of an image to describe — e.g. a logo or photo " +
          "URL from web_search results. Use when the image is not already in " +
          "the session. Exactly one of imageId or url is required.",
      ),
    question: z
      .string()
      .optional()
      .describe("Optional specific question to answer about the image."),
  })
  .superRefine((value, ctx) => {
    const hasId = Boolean(value.imageId?.trim());
    const hasUrl = Boolean(value.url?.trim());
    if (hasId === hasUrl) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of imageId or url",
        path: hasId ? ["url"] : ["imageId"],
      });
    }
  });

export type ViewImageToolOptions = {
  userId: string;
  sessionId: string;
  store: ImageStore;
  model: CompletionModel;
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Fallback for document page image ids (OCR images live in R2, not the image store). */
  resolveDocumentImage?: (
    imageId: string,
    userId: string,
    sessionId: string,
  ) => Promise<{ mediaType: string; buffer: Uint8Array } | null>;
};

/**
 * Subagent-as-tool for text-only models: a narrow, read-only tool that
 * describes a session image or a public image URL via a vision-capable chat
 * model (direct completion — no agent loop needed). Registered only when the
 * run's model cannot accept image input, so DeepSeek-class models can "see"
 * actual image content instead of only prompt text or alt captions.
 */
export function createViewImageTool(options: ViewImageToolOptions) {
  const { userId, sessionId, store, model, fetchFn = fetch } = options;
  return createTool({
    name: "view_image",
    description: VIEW_IMAGE_DESCRIPTION,
    input: viewImageInput,
    execute: async ({ imageId, url, question }) => {
      try {
        const loaded = imageId
          ? await loadSessionImage({
              imageId,
              userId,
              sessionId,
              store,
              resolveDocumentImage: options.resolveDocumentImage,
            })
          : await loadRemoteImage({ url: url!, fetchFn });
        if ("error" in loaded) return loaded.error;

        const result = await createCompletion(model, {
          messages: [
            Message.user([
              UserContent.imageBase64(
                loaded.buffer.toString("base64"),
                loaded.mediaType,
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
          imageId: imageId ?? null,
          url: url ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        return "Failed to view the image. Try again or skip it.";
      }
    },
  });
}

async function loadSessionImage(input: {
  imageId: string;
  userId: string;
  sessionId: string;
  store: ImageStore;
  resolveDocumentImage?: ViewImageToolOptions["resolveDocumentImage"];
}): Promise<
  | { buffer: Buffer; mediaType: string }
  | { error: string }
> {
  const image = await input.store.getImage(input.imageId);
  if (
    !image ||
    image.userId !== input.userId ||
    image.sessionId !== input.sessionId
  ) {
    if (input.resolveDocumentImage) {
      const documentImage = await input.resolveDocumentImage(
        input.imageId,
        input.userId,
        input.sessionId,
      );
      if (documentImage) {
        return {
          buffer: Buffer.from(documentImage.buffer),
          mediaType: documentImage.mediaType,
        };
      }
    }
    return {
      error:
        "Image not found in this session. Use an imageId from the active " +
        "image context, session history, or a get_document_page_images " +
        "result, or pass a public image url instead.",
    };
  }
  const data = await input.store.getObjectBuffer(image.r2Key);
  return {
    buffer: Buffer.from(data),
    mediaType: image.mediaType,
  };
}

/**
 * Fetch a public image URL with basic SSRF guards (private hosts/IPs blocked,
 * redirects re-validated, size capped, content-type checked).
 */
export async function loadRemoteImage(input: {
  url: string;
  fetchFn?: typeof fetch;
}): Promise<
  | { buffer: Buffer; mediaType: string }
  | { error: string }
> {
  const fetchFn = input.fetchFn ?? fetch;
  let current: URL;
  try {
    current = new URL(input.url);
  } catch {
    return { error: "Invalid image URL." };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const safety = await assertSafeImageUrl(current);
    if (safety) return { error: safety };

    let response: Response;
    try {
      response = await fetchFn(current.toString(), {
        redirect: "manual",
        headers: {
          Accept: "image/*,*/*;q=0.8",
          "User-Agent": "chat-with-document-view-image/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "network error";
      return { error: `Could not download the image (${message}).` };
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return { error: "Image URL redirected without a Location header." };
      }
      try {
        current = new URL(location, current);
      } catch {
        return { error: "Image URL redirected to an invalid location." };
      }
      continue;
    }

    if (!response.ok) {
      return {
        error: `Could not download the image (HTTP ${response.status}).`,
      };
    }

    const headerType =
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
      "";
    if (
      headerType &&
      !headerType.startsWith("image/") &&
      headerType !== "application/octet-stream"
    ) {
      return {
        error: `URL did not return an image (content-type: ${headerType}).`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return { error: "Image download was empty." };
    }
    if (arrayBuffer.byteLength > VIEW_IMAGE_MAX_BYTES) {
      return {
        error: `Image is too large (max ${VIEW_IMAGE_MAX_BYTES} bytes).`,
      };
    }

    const buffer = Buffer.from(arrayBuffer);
    const sniffed = sniffImageMediaType(buffer);
    const mediaType = headerType.startsWith("image/")
      ? headerType
      : sniffed ?? "image/jpeg";
    if (!mediaType.startsWith("image/")) {
      return { error: "URL did not return a recognizable image." };
    }
    return { buffer, mediaType };
  }

  return { error: "Image URL redirected too many times." };
}

/** Returns an error message when the URL must not be fetched; null if OK. */
export async function assertSafeImageUrl(url: URL): Promise<string | null> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Only http(s) image URLs are supported.";
  }
  if (url.username || url.password) {
    return "Image URLs with credentials are not allowed.";
  }

  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return "Invalid image URL host.";
  if (isBlockedHostname(host)) {
    return "That image host is not allowed.";
  }

  // Literal IP in the URL.
  const literalKind = isIP(host);
  if (literalKind === 4 || literalKind === 6) {
    if (isBlockedIp(host)) {
      return "That image host is not allowed.";
    }
    return null;
  }

  // Resolve DNS and reject private / link-local targets (SSRF).
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (records.length === 0) {
      return "Could not resolve the image host.";
    }
    for (const record of records) {
      if (isBlockedIp(record.address)) {
        return "That image host resolves to a private address.";
      }
    }
  } catch {
    return "Could not resolve the image host.";
  }

  return null;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "metadata"
  ) {
    return true;
  }
  return isBlockedIp(host);
}

export function isBlockedIp(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isBlockedIpv4(v4mapped[1]!);
  return isBlockedIpv4(ip);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  return false;
}

/** Minimal magic-byte sniff for common image types. */
export function sniffImageMediaType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
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
  resolveDocumentImage?: ViewImageToolOptions["resolveDocumentImage"];
}) {
  return createViewImageTool({
    ...options,
    store: getImageStore(),
  });
}
