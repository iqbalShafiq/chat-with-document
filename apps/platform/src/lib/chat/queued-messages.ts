import type { UIAttachment } from "@anvia/react";

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

export function chunkIds(ids: string[], size: number): string[][] {
  if (size <= 0) return [];
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
