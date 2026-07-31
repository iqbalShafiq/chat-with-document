import type { UIMessage } from "@anvia/react";
import { readChatMessageMeta } from "./message-metadata";
import {
  calendarDayKey,
  formatMessageDateLabel,
  shouldShowDateChipForMessage,
} from "./message-time";

export type ThreadDateItem = {
  type: "date";
  key: string;
  label: string;
  iso: string;
};

export type ThreadMessageItem = {
  type: "message";
  key: string;
  message: UIMessage;
};

export type ThreadItem = ThreadDateItem | ThreadMessageItem;

export function getMessageTimestamp(message: UIMessage): string | undefined {
  return readChatMessageMeta(message.metadata).createdAt;
}

/**
 * Insert WhatsApp-style date separators between messages when the calendar day changes.
 * Only one chip per calendar day — undated rows (tool steps) do not reset the day.
 */
export function groupMessagesWithDateSeparators(
  messages: UIMessage[],
  options?: {
    getTimestamp?: (message: UIMessage) => string | undefined;
    now?: Date;
  },
): ThreadItem[] {
  const getTimestamp = options?.getTimestamp ?? getMessageTimestamp;
  const now = options?.now;
  const items: ThreadItem[] = [];
  let previousDayKey: string | null = null;

  for (const message of messages) {
    const iso = getTimestamp(message);
    if (shouldShowDateChipForMessage(iso, previousDayKey) && iso) {
      const label = formatMessageDateLabel(iso, now);
      if (label) {
        items.push({
          type: "date",
          key: `date-${calendarDayKey(iso) ?? iso}-${items.length}`,
          label,
          iso,
        });
      }
      previousDayKey = calendarDayKey(iso);
    } else if (iso) {
      previousDayKey = calendarDayKey(iso) ?? previousDayKey;
    }

    items.push({
      type: "message",
      key: message.id,
      message,
    });
  }

  return items;
}
