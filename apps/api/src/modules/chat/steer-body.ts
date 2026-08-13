import type {
  SteerAttachment,
  SteerContextSnippet,
  SteerMessage,
} from "./steering.js";

export const MAX_STEER_MESSAGES = 20;
export const MAX_STEER_TEXT_CHARS = 32_000;
export const MAX_STEER_ATTACHMENTS = 8;
export const MAX_STEER_ATTACHMENT_BYTES = 8_000_000;
export const MAX_STEER_CLIENT_ID_CHARS = 64;
export const MAX_STEER_SNIPPET_CHARS = 2_000;

export type ParsedSteerBody = {
  sessionId: string;
  messages: SteerMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachments(value: unknown): SteerAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STEER_ATTACHMENTS) return null;
  const attachments: SteerAttachment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const mediaType = typeof entry.mediaType === "string" ? entry.mediaType : "";
    const data = typeof entry.data === "string" ? entry.data : "";
    if (
      mediaType.length === 0 ||
      data.length === 0 ||
      data.length > MAX_STEER_ATTACHMENT_BYTES
    ) {
      return null;
    }
    attachments.push({ mediaType, data });
  }
  return attachments;
}

function parseContextSnippet(value: unknown): {
  ok: boolean;
  snippet?: SteerContextSnippet;
} {
  if (value === undefined || value === null) return { ok: true };
  if (!isRecord(value)) return { ok: false };
  const text = typeof value.text === "string" ? value.text : "";
  if (text.length === 0 || text.length > MAX_STEER_SNIPPET_CHARS) {
    return { ok: false };
  }
  if (value.sourceRole !== "user" && value.sourceRole !== "assistant") {
    return { ok: false };
  }
  return { ok: true, snippet: { text, sourceRole: value.sourceRole } };
}

function parseSteerMessage(value: unknown): SteerMessage | null {
  if (!isRecord(value)) return null;
  const clientMessageId =
    typeof value.clientMessageId === "string" ? value.clientMessageId : "";
  if (
    clientMessageId.length === 0 ||
    clientMessageId.length > MAX_STEER_CLIENT_ID_CHARS
  ) {
    return null;
  }
  const text = typeof value.text === "string" ? value.text : null;
  if (text === null || text.length > MAX_STEER_TEXT_CHARS) return null;
  const attachments = parseAttachments(value.attachments);
  if (attachments === null) return null;
  if (text.trim().length === 0 && attachments.length === 0) return null;
  const snippet = parseContextSnippet(value.contextSnippet);
  if (!snippet.ok) return null;
  return {
    clientMessageId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(snippet.snippet ? { contextSnippet: snippet.snippet } : {}),
  };
}

export function parseSteerBody(value: unknown): ParsedSteerBody | null {
  if (!isRecord(value)) return null;
  const sessionId =
    typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (sessionId.length === 0) return null;
  if (
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > MAX_STEER_MESSAGES
  ) {
    return null;
  }
  const messages: SteerMessage[] = [];
  for (const entry of value.messages) {
    const message = parseSteerMessage(entry);
    if (message === null) return null;
    messages.push(message);
  }
  return { sessionId, messages };
}
