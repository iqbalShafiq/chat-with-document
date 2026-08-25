import {
  createHttpClientTransport,
  type ClientStreamRequest,
  type ClientTransport,
} from "@anvia/client";
import { EventStreamHttpError } from "@anvia/client/transport";
import type { ImageGenSettings } from "#/lib/api";
import type { ChatMessageMeta } from "./message-metadata";
import {
  ChatDataSchemas,
  ChatStreamMetadataSchema,
  type ChatDataMap,
  type ChatStreamMetadata,
} from "./client-data";

export type ChatReasoningEffort = "low" | "medium" | "high" | "max";

export type ChatRequestMetadata = {
  sessionId: string;
  documentIds: readonly string[];
  modelId: string;
  reasoningEffort: ChatReasoningEffort | null;
  webSearchEnabled: boolean;
  imageGenerationEnabled: boolean;
  deepResearchEnabled: boolean;
  imageGenSettings: ImageGenSettings | null;
};

export type ChatRequest = ClientStreamRequest<ChatRequestMetadata>;
export type ChatClientMetadata = ChatMessageMeta | ChatStreamMetadata;

export function requireChatReasoningEffort(
  value: string | null,
): ChatReasoningEffort | null {
  if (value === null) return null;
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  throw new Error("Chat reasoning effort is invalid.");
}

export type ChatTransportOptions = {
  endpoint: string | URL;
  getRequestMetadata(request: ChatRequest): ChatRequestMetadata;
  /** Protocol-test seam. Production omits this and uses the browser fetch. */
  fetch?: typeof fetch;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_DOCUMENTS = 100;
const MAX_IMAGE_SETTING_TEXT = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonBlankString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validImageSettings(value: unknown): value is ImageGenSettings {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, ["modelId", "aspectRatio", "quality", "background", "n"])
  ) {
    return false;
  }
  for (const key of ["modelId", "aspectRatio", "quality", "background"] as const) {
    if (key in value && !nonBlankString(value[key], MAX_IMAGE_SETTING_TEXT)) {
      return false;
    }
  }
  return !(
    "n" in value &&
    (typeof value.n !== "number" ||
      !Number.isSafeInteger(value.n) ||
      value.n < 1 ||
      value.n > 10)
  );
}

/**
 * Validate the product policy object immediately before serialization. The
 * server remains authoritative; this check prevents stale/contradictory UI
 * state from being hidden by a client-side default.
 */
export function assertChatRequestMetadata(
  value: unknown,
): asserts value is ChatRequestMetadata {
  if (!isRecord(value) || !hasExactKeys(value, [
    "sessionId",
    "documentIds",
    "modelId",
    "reasoningEffort",
    "webSearchEnabled",
    "imageGenerationEnabled",
    "deepResearchEnabled",
    "imageGenSettings",
  ])) {
    throw new Error("Chat request metadata is invalid.");
  }
  if (
    !nonBlankString(value.sessionId, MAX_IDENTIFIER_LENGTH) ||
    !UUID_PATTERN.test(value.sessionId) ||
    !nonBlankString(value.modelId, MAX_IDENTIFIER_LENGTH) ||
    !Array.isArray(value.documentIds) ||
    value.documentIds.length > MAX_DOCUMENTS ||
    new Set(value.documentIds).size !== value.documentIds.length ||
    value.documentIds.some(
      (id) => !nonBlankString(id, MAX_IDENTIFIER_LENGTH),
    ) ||
    (value.reasoningEffort !== null &&
      !["low", "medium", "high", "max"].includes(value.reasoningEffort as string)) ||
    typeof value.webSearchEnabled !== "boolean" ||
    typeof value.imageGenerationEnabled !== "boolean" ||
    typeof value.deepResearchEnabled !== "boolean" ||
    (value.imageGenSettings !== null && !validImageSettings(value.imageGenSettings)) ||
    (!value.imageGenerationEnabled && value.imageGenSettings !== null)
  ) {
    throw new Error("Chat request metadata is invalid.");
  }
}

/** Replace persisted v3 metadata without copying any stale/unknown fields. */
export function withCurrentRequestMetadata(
  request: ClientStreamRequest,
  metadata: ChatRequestMetadata,
): ChatRequest {
  if (request.type === "messages") {
    const latestPrompt = request.messages.at(-1);
    if (!latestPrompt || latestPrompt.role !== "user") {
      throw new Error("Chat request has no latest user prompt.");
    }
    return {
      type: "messages",
      // This product uses Anvia memory on the server as conversation truth.
      // Keep the full UI history in useChat/resume storage, but send only the
      // new prompt across the trust boundary so generated reasoning and stale
      // client history are never replayed as authoritative input.
      messages: [latestPrompt],
      metadata,
      ...(request.resume === undefined ? {} : { resume: request.resume }),
    };
  }
  return {
    type: "interaction_response",
    interactionId: request.interactionId,
    response: request.response,
    metadata,
    ...(request.resume === undefined ? {} : { resume: request.resume }),
  };
}

export function createAnviaChatTransport(
  options: ChatTransportOptions,
): ClientTransport<ChatRequest, ChatDataMap, ChatClientMetadata> {
  return createHttpClientTransport<ChatRequest, ChatDataMap, ChatClientMetadata>({
    endpoint: options.endpoint,
    method: "POST",
    format: "jsonl",
    init: { credentials: "include" },
    headers: { "content-type": "application/json" },
    metadataSchema: ChatStreamMetadataSchema,
    dataSchemas: ChatDataSchemas,
    body: ({ request }) => {
      const metadata = options.getRequestMetadata(request);
      assertChatRequestMetadata(metadata);
      return JSON.stringify(withCurrentRequestMetadata(request, metadata));
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/** Parse only the bounded API conflict shape that the UI owns. */
export function isRunActiveConflict(error: unknown): boolean {
  if (!(error instanceof EventStreamHttpError) || error.response.status !== 409) {
    return false;
  }
  if (error.body.length > 2_048) return false;
  try {
    const parsed: unknown = JSON.parse(error.body);
    return (
      isRecord(parsed) &&
      Object.keys(parsed).length === 2 &&
      parsed.code === "RUN_ACTIVE" &&
      typeof parsed.error === "string" &&
      parsed.error.length > 0 &&
      parsed.error.length <= 512
    );
  } catch {
    return false;
  }
}

export function isAuthFailure(error: unknown): boolean {
  return error instanceof EventStreamHttpError && error.response.status === 401;
}

export function stopChatPreservingMessages<T>(
  controller: {
    readonly messages: readonly T[];
    stop(): void;
    setMessages(messages: readonly T[]): void;
  },
  finalize: (messages: readonly T[]) => readonly T[],
): void {
  const snapshot = controller.messages;
  controller.stop();
  controller.setMessages(finalize(snapshot));
}
