import { useCallback, useEffect, useRef, useState } from "react";
import {
  addQueuedItem,
  applyQueuedAck,
  cancelQueuedEdit,
  finishQueuedEdit,
  markQueuedItemsInflight,
  readQueue,
  removeQueuedItem,
  reorderQueuedItem,
  revertInflightItems,
  startQueuedEdit,
  writeQueue,
  type QueuedDraft,
  type QueuedItem,
} from "#/lib/chat/queued-messages";

export type QueueActions = {
  queueItem(draft: QueuedDraft): void;
  removeItem(id: string): void;
  reorder(fromIndex: number, toIndex: number): void;
  startEdit(id: string): void;
  submitEdit(id: string, draft: QueuedDraft): void;
  cancelEdit(id: string): void;
  markInflight(ids: ReadonlySet<string>): void;
  revertInflight(): void;
  applyAck(id: string): void;
  replaceAll(items: QueuedItem[]): void;
};

export function useQueuedMessages(sessionId: string): {
  items: QueuedItem[];
  actions: QueueActions;
} {
  const [items, setItems] = useState<QueuedItem[]>(() => readQueue(sessionId));
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    setItems(readQueue(sessionId));
  }, [sessionId]);

  useEffect(() => {
    writeQueue(sessionId, items);
  }, [sessionId, items]);

  const update = useCallback((next: QueuedItem[]) => {
    setItems(next);
  }, []);

  const actions: QueueActions = {
    queueItem: (draft) => {
      update(
        addQueuedItem(itemsRef.current, {
          ...draft,
          id: crypto.randomUUID(),
          status: "pending",
        }),
      );
    },
    removeItem: (id) => update(removeQueuedItem(itemsRef.current, id)),
    reorder: (fromIndex, toIndex) =>
      update(reorderQueuedItem(itemsRef.current, fromIndex, toIndex)),
    startEdit: (id) => update(startQueuedEdit(itemsRef.current, id)),
    submitEdit: (id, draft) =>
      update(finishQueuedEdit(itemsRef.current, id, draft)),
    cancelEdit: (id) => update(cancelQueuedEdit(itemsRef.current, id)),
    markInflight: (ids) =>
      update(markQueuedItemsInflight(itemsRef.current, ids)),
    revertInflight: () => update(revertInflightItems(itemsRef.current)),
    applyAck: (id) => update(applyQueuedAck(itemsRef.current, id)),
    replaceAll: (next) => update(next),
  };

  return { items, actions };
}
