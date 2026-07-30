import { prisma } from "../../utils/prisma.js";

export type SessionListItem = {
  sessionId: string;
  updatedAt: string;
  title: string;
};

export type SessionListPage = {
  items: SessionListItem[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const TITLE_MAX = 48;

function clampLimit(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Cursor format: `${isoUpdatedAt}|${sessionId}` */
function parseCursor(
  raw: string | undefined,
): { updatedAt: Date; sessionId: string } | null {
  if (!raw || !raw.includes("|")) return null;
  const sep = raw.indexOf("|");
  const iso = raw.slice(0, sep);
  const sessionId = raw.slice(sep + 1);
  if (!sessionId) return null;
  const updatedAt = new Date(iso);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, sessionId };
}

function encodeCursor(updatedAt: Date, sessionId: string): string {
  return `${updatedAt.toISOString()}|${sessionId}`;
}

/** True if `row` comes after `cursor` in desc (updatedAt, sessionId) order. */
function isAfterCursor(
  row: { updatedAt: Date; sessionId: string },
  cursor: { updatedAt: Date; sessionId: string },
): boolean {
  if (row.updatedAt.getTime() < cursor.updatedAt.getTime()) return true;
  if (row.updatedAt.getTime() > cursor.updatedAt.getTime()) return false;
  return row.sessionId.localeCompare(cursor.sessionId) < 0;
}

function extractTextFromMessageJson(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const record = message as Record<string, unknown>;

  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const part of record.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        texts.push(p.text.trim());
      }
    }
    if (texts.length > 0) return texts.join(" ");
  }

  if (Array.isArray(record.parts)) {
    const texts: string[] = [];
    for (const part of record.parts) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        texts.push(p.text.trim());
      }
    }
    if (texts.length > 0) return texts.join(" ");
  }

  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }

  return null;
}

function truncateTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX - 1)}…`;
}

async function titlesForSessions(
  sessionIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (sessionIds.length === 0) return map;

  const sessions = await prisma.agentMemorySession.findMany({
    where: { sessionId: { in: sessionIds } },
    select: {
      sessionId: true,
      messages: {
        where: { role: "user" },
        orderBy: { position: "asc" },
        take: 1,
        select: { message: true },
      },
    },
  });

  for (const session of sessions) {
    if (map.has(session.sessionId)) continue;
    const first = session.messages[0];
    if (!first) continue;
    const text = extractTextFromMessageJson(first.message);
    if (text) map.set(session.sessionId, truncateTitle(text));
  }

  return map;
}

/**
 * Distinct sessions ordered by latest updatedAt desc, with pagination cursor.
 *
 * Pragmatic note: we read a capped window (MAX_SCAN), dedupe in memory, then
 * page. True SQL DISTINCT+cursor is more work than this app needs while
 * session counts stay small (personal / assignment scale).
 */
const MAX_SCAN = 300;

export async function listSessionsPage(input: {
  cursor?: string;
  limit?: string;
}): Promise<SessionListPage> {
  const limit = clampLimit(input.limit);
  const cursor = parseCursor(input.cursor);

  const rows = await prisma.agentMemorySession.findMany({
    select: { sessionId: true, updatedAt: true },
    orderBy: [{ updatedAt: "desc" }, { sessionId: "desc" }],
    take: MAX_SCAN,
  });

  const seen = new Set<string>();
  const unique: Array<{ sessionId: string; updatedAt: Date }> = [];
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    unique.push({ sessionId: row.sessionId, updatedAt: row.updatedAt });
  }

  let start = 0;
  if (cursor) {
    const idx = unique.findIndex((row) => isAfterCursor(row, cursor));
    start = idx < 0 ? unique.length : idx;
  }

  const page = unique.slice(start, start + limit);
  const titles = await titlesForSessions(page.map((p) => p.sessionId));

  const items: SessionListItem[] = page.map((row) => ({
    sessionId: row.sessionId,
    updatedAt: row.updatedAt.toISOString(),
    title: titles.get(row.sessionId) ?? "New chat",
  }));

  const last = page[page.length - 1];
  const hasMore = start + limit < unique.length;
  const nextCursor =
    hasMore && last ? encodeCursor(last.updatedAt, last.sessionId) : null;

  return { items, nextCursor };
}
