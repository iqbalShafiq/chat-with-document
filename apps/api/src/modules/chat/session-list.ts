import { prisma } from "../../utils/prisma.js";

export type SessionListItem = {
  sessionId: string;
  updatedAt: string;
  title: string;
  projectId: string | null;
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
  userId: string,
  sessionIds: string[],
  cached: Map<string, string | null>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (sessionIds.length === 0) return map;

  const needMemory: string[] = [];
  for (const id of sessionIds) {
    const title = cached.get(id);
    if (title && title.trim()) {
      map.set(id, title.trim());
    } else {
      needMemory.push(id);
    }
  }

  if (needMemory.length === 0) return map;

  const sessions = await prisma.agentMemorySession.findMany({
    where: { userId, sessionId: { in: needMemory } },
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
 * List chat sessions from durable ChatSession rows.
 * - projectId omitted / null → standalone only (projectId IS NULL)
 * - projectId set → that project only
 */
export async function listSessionsPage(input: {
  userId: string;
  cursor?: string;
  limit?: string;
  projectId?: string | null;
}): Promise<SessionListPage> {
  const limit = clampLimit(input.limit);
  const cursor = parseCursor(input.cursor);

  const where: {
    userId: string;
    projectId?: string | null;
    OR?: Array<Record<string, unknown>>;
  } = { userId: input.userId };

  if (input.projectId) {
    where.projectId = input.projectId;
  } else {
    // Standalone only (default product list)
    where.projectId = null;
  }

  if (cursor) {
    where.OR = [
      { updatedAt: { lt: cursor.updatedAt } },
      {
        AND: [
          { updatedAt: cursor.updatedAt },
          { id: { lt: cursor.sessionId } },
        ],
      },
    ];
  }

  const rows = await prisma.chatSession.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      updatedAt: true,
      title: true,
      projectId: true,
    },
  });

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  const cachedTitles = new Map(
    page.map((r) => [r.id, r.title] as const),
  );
  const titles = await titlesForSessions(
    input.userId,
    page.map((p) => p.id),
    cachedTitles,
  );

  const items: SessionListItem[] = page.map((row) => ({
    sessionId: row.id,
    updatedAt: row.updatedAt.toISOString(),
    title: titles.get(row.id) ?? row.title ?? "New chat",
    projectId: row.projectId,
  }));

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

  return { items, nextCursor };
}
