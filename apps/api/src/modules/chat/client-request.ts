import {
  parseClientStreamRequest,
  type ClientStreamCursor,
  type ClientStreamRequest,
} from "@anvia/client";
import type {
  AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type { Message } from "@anvia/core/completion";
import z from "zod";
import { chatAgentImageGenSettingsSchema } from "./run-recipe.js";

const IDENTIFIER_MAX_LENGTH = 256;
export const MAX_CHAT_DOCUMENTS = 100;
export const MAX_CHAT_MESSAGES = 100;
export const MAX_CHAT_MESSAGE_CONTENT_CHARS = 32_000;
export const MAX_CHAT_CONTENT_PARTS = 100;

const boundedIdentifier = z
  .string()
  .max(IDENTIFIER_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, "must not be blank");

const uuidIdentifier = z.string().uuid();

/**
 * Product policy carried alongside Anvia's canonical client request. This is
 * deliberately separate from the event metadata schema: documents and
 * feature selection are authorization inputs, not stream decorations.
 */
export const ChatRequestMetadataSchema = z
  .object({
    sessionId: uuidIdentifier,
    documentIds: z
      .array(boundedIdentifier)
      .max(MAX_CHAT_DOCUMENTS)
      .refine((ids) => new Set(ids).size === ids.length, "document ids must be unique"),
    modelId: boundedIdentifier,
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).nullable(),
    webSearchEnabled: z.boolean(),
    imageGenerationEnabled: z.boolean(),
    deepResearchEnabled: z.boolean(),
    imageGenSettings: chatAgentImageGenSettingsSchema.nullable(),
  })
  .strict();

export type ChatRequestMetadata = z.infer<typeof ChatRequestMetadataSchema>;

const cursorSchema = z
  .object({
    streamId: boundedIdentifier,
    after: z.number().int().nonnegative().safe(),
  })
  .strict();

export type ParsedChatRequest =
  | {
      kind: "messages";
      messages: readonly Message[];
      metadata: ChatRequestMetadata;
    }
  | {
      kind: "interaction_response";
      interactionId: string;
      response: AgentInteractionResponse;
      metadata: ChatRequestMetadata;
    }
  | {
      kind: "resume";
      request: ClientStreamRequest;
      metadata: ChatRequestMetadata;
      cursor: ClientStreamCursor;
    };

export type ChatRequestErrorCode =
  | "INVALID_CLIENT_REQUEST"
  | "INVALID_REQUEST_METADATA"
  | "INVALID_IMAGE_SETTINGS"
  | "INVALID_MESSAGE"
  | "UNSUPPORTED_MODEL";

/** Safe, bounded error that can be returned by the API without echoing input. */
export class ChatRequestError extends Error {
  readonly name = "ChatRequestError";

  constructor(
    readonly code: ChatRequestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function safeMessage(code: ChatRequestErrorCode): string {
  switch (code) {
    case "INVALID_REQUEST_METADATA":
      return "request metadata is invalid";
    case "INVALID_IMAGE_SETTINGS":
      return "image generation settings are invalid";
    case "INVALID_MESSAGE":
      return "messages are invalid";
    case "UNSUPPORTED_MODEL":
      return "the selected model is not supported";
    case "INVALID_CLIENT_REQUEST":
    default:
      return "client request is invalid";
  }
}

function fail(code: ChatRequestErrorCode): never {
  throw new ChatRequestError(code, safeMessage(code));
}

function parseMetadata(value: unknown): ChatRequestMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_REQUEST_METADATA");
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.imageGenSettings !== null) {
    const imageSettings = candidate.imageGenSettings;
    if (
      imageSettings === undefined ||
      chatAgentImageGenSettingsSchema.safeParse(imageSettings).success === false
    ) {
      return fail("INVALID_IMAGE_SETTINGS");
    }
  }

  const parsed = ChatRequestMetadataSchema.safeParse(value);
  if (!parsed.success) return fail("INVALID_REQUEST_METADATA");
  if (!parsed.data.imageGenerationEnabled && parsed.data.imageGenSettings !== null) {
    return fail("INVALID_IMAGE_SETTINGS");
  }
  return parsed.data;
}

function parseCursor(value: unknown): ClientStreamCursor {
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success) return fail("INVALID_CLIENT_REQUEST");
  return parsed.data;
}

function parseOfficialRequest(value: unknown): ClientStreamRequest {
  try {
    return parseClientStreamRequest(value);
  } catch {
    return fail("INVALID_CLIENT_REQUEST");
  }
}

function assertMessageBounds(messages: readonly Message[]): void {
  if (messages.length > MAX_CHAT_MESSAGES) fail("INVALID_MESSAGE");
  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.length > MAX_CHAT_MESSAGE_CONTENT_CHARS) fail("INVALID_MESSAGE");
      continue;
    }
    if (!Array.isArray(message.content) || message.content.length > MAX_CHAT_CONTENT_PARTS) fail("INVALID_MESSAGE");
    let total = 0;
    for (const part of message.content) {
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") total += part.text.length;
      if (total > MAX_CHAT_MESSAGE_CONTENT_CHARS) fail("INVALID_MESSAGE");
    }
  }
}

/**
 * Parse the only accepted chat request grammar. Anvia owns protocol parsing;
 * this module adds product metadata and semantic message policy afterwards.
 */
export function parseChatClientRequest(value: unknown): ParsedChatRequest {
  const request = parseOfficialRequest(value);
  if (request.type === "messages") assertMessageBounds(request.messages);
  const metadata = parseMetadata(request.metadata);

  if (request.resume !== undefined) {
    return {
      kind: "resume",
      request,
      metadata,
      cursor: parseCursor(request.resume),
    };
  }

  if (request.type === "interaction_response") {
    const interactionId = boundedIdentifier.safeParse(request.interactionId);
    if (!interactionId.success) return fail("INVALID_CLIENT_REQUEST");
    return {
      kind: "interaction_response",
      interactionId: interactionId.data,
      response: request.response,
      metadata,
    };
  }

  if (request.messages.length === 0) return fail("INVALID_MESSAGE");
  const lastMessage = request.messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") return fail("INVALID_MESSAGE");

  return {
    kind: "messages",
    messages: request.messages,
    metadata,
  };
}

/** Explicit name for route call sites that want to show the transport seam. */
export const parseClientRequest = parseChatClientRequest;
