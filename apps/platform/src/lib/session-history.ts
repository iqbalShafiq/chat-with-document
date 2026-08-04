import type { SessionListItem } from "#/lib/api";

/** Same shape as API session list items — one type keeps client/server aligned. */
export type SessionSummary = SessionListItem;

export type SessionDateGroup = {
  label: string;
  items: SessionSummary[];
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatMonthYear(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatDayMonthYear(d: Date): string {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Group sessions for sidebar labels: Today, Yesterday, then calendar buckets.
 */
export function groupSessionsByDate(
  items: SessionSummary[],
  now = new Date(),
): SessionDateGroup[] {
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups = new Map<string, SessionSummary[]>();
  const order: string[] = [];

  const push = (label: string, item: SessionSummary) => {
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(item);
  };

  for (const item of items) {
    const d = new Date(item.updatedAt);
    if (Number.isNaN(d.getTime())) {
      push("Earlier", item);
      continue;
    }

    if (isSameDay(d, today)) {
      push("Today", item);
    } else if (isSameDay(d, yesterday)) {
      push("Yesterday", item);
    } else if (d.getFullYear() === now.getFullYear()) {
      const daysAgo =
        (today.getTime() - startOfDay(d).getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo < 7) {
        push(formatDayMonthYear(d), item);
      } else {
        push(formatMonthYear(d), item);
      }
    } else {
      push(formatMonthYear(d), item);
    }
  }

  return order.map((label) => ({
    label,
    items: groups.get(label)!,
  }));
}

/** UI / list title for an empty draft that has no first user message yet. */
export const EMPTY_CHAT_TITLE = "New chat";

/** True when the session is still an empty draft (no title from first message). */
export function isEmptyNewChat(session: Pick<SessionSummary, "title">): boolean {
  const title = session.title?.trim() || EMPTY_CHAT_TITLE;
  return title === EMPTY_CHAT_TITLE;
}

/**
 * Prefer reusing an existing empty draft in the current list (already
 * standalone- or project-scoped by the loader) instead of creating another.
 */
export function findEmptyNewChat(
  list: SessionSummary[] | null | undefined,
): SessionSummary | null {
  const safe = Array.isArray(list) ? list : [];
  return safe.find((s) => isEmptyNewChat(s)) ?? null;
}

/**
 * Keep list as-is when active is already present.
 * Does NOT invent phantom "New chat" rows — those stack empties across
 * project/standalone switches. Callers should set sessionId from the list
 * or from getOrCreateEmptyChatSession.
 */
export function ensureActiveSession(
  list: SessionSummary[] | null | undefined,
  _activeId: string,
  _projectId: string | null = null,
): SessionSummary[] {
  return Array.isArray(list) ? list : [];
}

/** Map draft API payload into a sidebar list row. */
export function sessionSummaryFromDraft(draft: {
  sessionId: string;
  projectId: string | null;
  title?: string | null;
  updatedAt?: string;
}): SessionSummary {
  return {
    sessionId: draft.sessionId,
    projectId: draft.projectId,
    title: draft.title?.trim() || EMPTY_CHAT_TITLE,
    updatedAt: draft.updatedAt ?? new Date().toISOString(),
  };
}

/** Relative time for project cards (e.g. "2 min ago", "Yesterday"). */
export function formatRelativeUpdatedAt(
  iso: string,
  now = new Date(),
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = now.getTime() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
