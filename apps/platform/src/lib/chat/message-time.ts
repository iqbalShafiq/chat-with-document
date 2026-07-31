/** Local calendar day key YYYY-MM-DD for date separators. */
export function calendarDayKey(iso: string, now = new Date()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  // Validate timezone-local formatting is stable; `now` reserved for tests.
  void now;
  return `${y}-${m}-${d}`;
}

/** Short clock time for bubble footers (e.g. 14:32). */
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
 * Day label for timeline date cards (Today / Yesterday / weekday / 31 Jul).
 * Sized for a "Latest"-style glass pill, not a narrow rail gutter.
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

  if (diffDays > 1 && diffDays < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  }

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

export function shouldInsertDateSeparator(
  previousIso: string | undefined,
  currentIso: string | undefined,
): boolean {
  if (!currentIso) return false;
  const currentKey = calendarDayKey(currentIso);
  if (!currentKey) return false;
  if (!previousIso) return true;
  const previousKey = calendarDayKey(previousIso);
  // Only skip when we know the previous day and it matches.
  // Missing previous key is handled by callers that scan for the last known day.
  if (!previousKey) return true;
  return previousKey !== currentKey;
}

/**
 * Walk backward to the nearest message that has a usable calendar day.
 * Skips tool / intermediate rows without timestamps so we do not re-emit a
 * "Today" chip between every turn of the same day.
 */
export function findPreviousDayKey(
  getTimestamp: (index: number) => string | undefined,
  fromIndex: number,
): string | null {
  for (let i = fromIndex - 1; i >= 0; i -= 1) {
    const iso = getTimestamp(i);
    if (!iso) continue;
    const key = calendarDayKey(iso);
    if (key) return key;
  }
  return null;
}

/** True when this message opens a new calendar day vs the last dated message. */
export function shouldShowDateChipForMessage(
  currentIso: string | undefined,
  previousDayKey: string | null,
): boolean {
  if (!currentIso) return false;
  const currentKey = calendarDayKey(currentIso);
  if (!currentKey) return false;
  if (previousDayKey === null) return true;
  return previousDayKey !== currentKey;
}
