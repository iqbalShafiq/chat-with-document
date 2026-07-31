/** Short clock time (e.g. 14:32). */
export function formatMessageTime(iso: string, locale?: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Full datetime for title / aria-label. */
export function formatMessageDateTime(
  iso: string,
  locale?: string,
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Relative day label for bubble timestamps: Today / Yesterday / short date.
 */
export function formatMessageDateLabel(
  iso: string,
  now = new Date(),
  locale?: string,
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const day = startOfLocalDay(date).getTime();
  const today = startOfLocalDay(now).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((today - day) / dayMs);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

/**
 * Bubble timestamp: "Today • 14:32", "Yesterday • 09:15", or "31 Jul • 14:32".
 */
export function formatMessageBubbleTimestamp(
  iso: string,
  now = new Date(),
  locale?: string,
): string | null {
  const dateLabel = formatMessageDateLabel(iso, now, locale);
  const timeLabel = formatMessageTime(iso, locale);
  if (!dateLabel || !timeLabel) return null;
  return `${dateLabel} • ${timeLabel}`;
}
