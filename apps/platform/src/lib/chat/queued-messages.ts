import type { UIAttachment } from "@anvia/client";
import type { ImageGenSettings } from "#/lib/api";

export type QueuedContextSnippet = {
  text: string;
  sourceRole: "user" | "assistant";
};

export type QueuedItemStatus = "pending" | "inflight" | "editing";

export type QueuedItem = {
  id: string;
  text: string;
  attachments: UIAttachment[];
  documentIds: string[];
  contextSnippet: QueuedContextSnippet | null;
  pinnedImageIds: string[];
  status: QueuedItemStatus;
};

export type QueuedDraft = Omit<QueuedItem, "id" | "status">;

export const QUEUE_STORAGE_PREFIX = "chat.queue.";

export function queueStorageKey(sessionId: string): string {
  return `${QUEUE_STORAGE_PREFIX}${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachment(value: unknown): UIAttachment | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type !== "image" && type !== "document" && type !== "file") return null;
  const id = typeof value.id === "string" ? value.id : null;
  if (id === null) return null;
  const attachment: UIAttachment = { id, type };
  if (typeof value.name === "string") attachment.name = value.name;
  if (typeof value.mediaType === "string") attachment.mediaType = value.mediaType;
  if (typeof value.data === "string") attachment.data = value.data;
  if (typeof value.url === "string") attachment.url = value.url;
  if (typeof value.text === "string") attachment.text = value.text;
  return attachment;
}

function parseSnippet(value: unknown): QueuedContextSnippet | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.text !== "string" ||
    (value.sourceRole !== "user" && value.sourceRole !== "assistant")
  ) {
    return null;
  }
  return { text: value.text, sourceRole: value.sourceRole };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

function parseQueuedItem(entry: unknown): QueuedItem | null {
  if (!isRecord(entry)) return null;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (id.length === 0) return null;
  const text = typeof entry.text === "string" ? entry.text : null;
  if (text === null) return null;
  const attachmentsRaw = entry.attachments;
  if (attachmentsRaw !== undefined && !Array.isArray(attachmentsRaw)) return null;
  const attachments = (attachmentsRaw ?? [])
    .flatMap((value) => {
      const parsed = parseAttachment(value);
      return parsed === null ? [] : [parsed];
    });
  const documentIds = parseStringArray(entry.documentIds);
  if (documentIds === null) return null;
  const pinnedImageIds = parseStringArray(entry.pinnedImageIds);
  if (pinnedImageIds === null) return null;
  const contextSnippet = parseSnippet(entry.contextSnippet);
  return {
    id,
    text,
    attachments,
    documentIds,
    contextSnippet,
    pinnedImageIds,
    // Restored items always start pending: an in-flight steer belongs to a
    // past tab session; the server dedupes re-posts per stream.
    status: "pending",
  };
}

export function readQueue(sessionId: string): QueuedItem[] {
  try {
    const raw = localStorage.getItem(queueStorageKey(sessionId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const item = parseQueuedItem(entry);
      return item === null ? [] : [item];
    });
  } catch {
    return [];
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

export function writeQueue(sessionId: string, items: QueuedItem[]): void {
  const key = queueStorageKey(sessionId);
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch (error) {
    if (!isQuotaError(error)) return;
    // Quota exceeded (large image data) — degrade to text/reference only.
    try {
      const degraded = items.map((item) => ({
        ...item,
        attachments: item.attachments.map((attachment) => ({
          ...attachment,
          data: undefined,
        })),
      }));
      localStorage.setItem(key, JSON.stringify(degraded));
    } catch {
      // Storage unavailable — the in-memory queue still works this session.
    }
  }
}

export function addQueuedItem(
  items: QueuedItem[],
  item: QueuedItem,
): QueuedItem[] {
  return [...items, item];
}

export function removeQueuedItem(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.filter((item) => item.id !== id);
}

export function reorderQueuedItem(
  items: QueuedItem[],
  fromIndex: number,
  toIndex: number,
): QueuedItem[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function markQueuedItemsInflight(
  items: QueuedItem[],
  ids: ReadonlySet<string>,
): QueuedItem[] {
  return items.map((item) =>
    item.status === "pending" && ids.has(item.id)
      ? { ...item, status: "inflight" }
      : item,
  );
}

export function revertInflightItems(items: QueuedItem[]): QueuedItem[] {
  return items.map((item) =>
    item.status === "inflight" ? { ...item, status: "pending" } : item,
  );
}

export function applyQueuedAck(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.filter((item) => item.id !== id);
}

export function startQueuedEdit(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.map((item) =>
    item.id === id ? { ...item, status: "editing" } : item,
  );
}

export function finishQueuedEdit(
  items: QueuedItem[],
  id: string,
  draft: QueuedDraft,
): QueuedItem[] {
  return items.map((item) =>
    item.id === id ? { ...draft, id, status: "pending" } : item,
  );
}

export function cancelQueuedEdit(
  items: QueuedItem[],
  id: string,
): QueuedItem[] {
  return items.map((item) =>
    item.id === id ? { ...item, status: "pending" } : item,
  );
}

/** First pending item; stops at the first editing item (flush waits for it). */
export function nextFlushableItem(items: QueuedItem[]): {
  index: number;
  item: QueuedItem;
} | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.status === "editing") return null;
    if (item.status === "pending") return { index, item };
  }
  return null;
}

/** Pending items in order up to (not including) the first editing item. */
export function pendingBeforeEditing(items: QueuedItem[]): QueuedItem[] {
  const pending: QueuedItem[] = [];
  for (const item of items) {
    if (item.status === "editing") break;
    if (item.status === "pending") pending.push(item);
  }
  return pending;
}

export function chunkIds<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export const SHARE_FORK_DRAFT_PREFIX = "chat.share-fork-draft.";

export function shareForkDraftKey(sessionId: string): string {
  return `${SHARE_FORK_DRAFT_PREFIX}${sessionId}`;
}

export type ShareForkDraftAttachment = Pick<
  UIAttachment,
  "id" | "type" | "name" | "mediaType" | "data" | "url" | "text"
>;

export type ShareForkDraft = {
  version: 1;
  text: string;
  attachments: ShareForkDraftAttachment[];
  webSearchEnabled: boolean;
  deepResearchEnabled: boolean;
  imageGenerationEnabled: boolean;
  imageGenSettings: ImageGenSettings;
};

function isShareForkAttachment(value: unknown): value is ShareForkDraftAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    (record.type === "image" ||
      record.type === "document" ||
      record.type === "file") &&
    (record.name === undefined || typeof record.name === "string") &&
    (record.mediaType === undefined || typeof record.mediaType === "string") &&
    (record.data === undefined || typeof record.data === "string") &&
    (record.url === undefined || typeof record.url === "string") &&
    (record.text === undefined || typeof record.text === "string")
  );
}

function isShareForkDraft(value: unknown): value is ShareForkDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const settings = record.imageGenSettings;
  return (
    record.version === 1 &&
    typeof record.text === "string" &&
    Array.isArray(record.attachments) &&
    record.attachments.every(isShareForkAttachment) &&
    typeof record.webSearchEnabled === "boolean" &&
    typeof record.deepResearchEnabled === "boolean" &&
    typeof record.imageGenerationEnabled === "boolean" &&
    typeof settings === "object" &&
    settings !== null &&
    !Array.isArray(settings)
  );
}

function sanitizeImageGenSettings(value: unknown): ImageGenSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const settings: ImageGenSettings = {};
  if (typeof record.modelId === "string") settings.modelId = record.modelId;
  if (typeof record.aspectRatio === "string") {
    settings.aspectRatio = record.aspectRatio;
  }
  if (typeof record.quality === "string") settings.quality = record.quality;
  if (typeof record.background === "string") {
    settings.background = record.background;
  }
  if (typeof record.n === "number" && Number.isSafeInteger(record.n)) {
    settings.n = record.n;
  }
  return settings;
}

/**
 * One-shot handoff for the share-fork first send: the share page stores the
 * exact composer draft (text + attachments + feature toggles), navigates to
 * the viewer's own `/chat/<newId>` room, and that room consumes + auto-sends
 * it once through the standard pipeline. Same-tab navigation only; a stale
 * entry is consumed once and dropped, never re-sent.
 */
export function queueShareForkDraft(
  sessionId: string,
  input: {
    text: string;
    attachments: UIAttachment[];
    webSearchEnabled: boolean;
    deepResearchEnabled: boolean;
    imageGenerationEnabled: boolean;
    imageGenSettings: ImageGenSettings;
  },
): void {
  const payload: ShareForkDraft = {
    version: 1,
    text: input.text,
    attachments: input.attachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      ...(attachment.name !== undefined ? { name: attachment.name } : {}),
      ...(attachment.mediaType !== undefined
        ? { mediaType: attachment.mediaType }
        : {}),
      ...(attachment.data !== undefined ? { data: attachment.data } : {}),
      ...(attachment.url !== undefined ? { url: attachment.url } : {}),
      ...(attachment.text !== undefined ? { text: attachment.text } : {}),
    })),
    webSearchEnabled: input.webSearchEnabled,
    deepResearchEnabled: input.deepResearchEnabled,
    imageGenerationEnabled: input.imageGenerationEnabled,
    imageGenSettings: sanitizeImageGenSettings(input.imageGenSettings),
  };
  try {
    sessionStorage.setItem(shareForkDraftKey(sessionId), JSON.stringify(payload));
  } catch {
    // Storage unavailable — the target room renders without a handoff draft.
  }
}

/** Consume (read + delete) the one-shot share-fork draft for a session. */
export function consumeShareForkDraft(sessionId: string): ShareForkDraft | null {
  const key = shareForkDraftKey(sessionId);
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isShareForkDraft(parsed)) return null;
    if (!parsed.text.trim() && parsed.attachments.length === 0) return null;
    return {
      ...parsed,
      imageGenSettings: sanitizeImageGenSettings(parsed.imageGenSettings),
    };
  } catch {
    return null;
  }
}
