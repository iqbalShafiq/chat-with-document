/**
 * Shared citation parse + groundedness helpers (agent/API).
 * Keep in sync with apps/platform/src/lib/chat/citations.ts contract.
 */

export type ParsedCitation = {
  id: number;
  documentId?: string;
  filename: string;
  pageIndex?: number;
  pageId?: string;
  chunkId?: string;
  snippet?: string;
};

export type CitationGroundedness = {
  markerIds: number[];
  trailerIds: number[];
  matchedIds: number[];
  orphanMarkerIds: number[];
  orphanTrailerIds: number[];
  markerCount: number;
  trailerCount: number;
  /** 0–1 structural score; null when no citation signal at all. */
  score: number | null;
  hasAnySignal: boolean;
};

const CITE_MARKER_RE = /\[\[cite:(\d+)\]\]/g;
const CITATIONS_FENCE_RE = /```citations\s*\r?\n([\s\S]*?)```/gi;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCitationItem(raw: unknown): ParsedCitation | null {
  if (!isPlainObject(raw)) return null;

  const id =
    typeof raw.id === "number" && Number.isInteger(raw.id) && raw.id > 0
      ? raw.id
      : typeof raw.id === "string" && /^\d+$/.test(raw.id)
        ? Number(raw.id)
        : null;
  if (id === null) return null;

  const filename =
    typeof raw.filename === "string" && raw.filename.trim().length > 0
      ? raw.filename.trim()
      : typeof raw.documentId === "string" && raw.documentId.trim().length > 0
        ? raw.documentId.trim()
        : null;
  if (filename === null) return null;

  const citation: ParsedCitation = { id, filename };

  if (typeof raw.documentId === "string" && raw.documentId.trim()) {
    citation.documentId = raw.documentId.trim();
  }
  if (
    typeof raw.pageIndex === "number" &&
    Number.isInteger(raw.pageIndex) &&
    raw.pageIndex >= 0
  ) {
    citation.pageIndex = raw.pageIndex;
  }
  if (typeof raw.pageId === "string" && raw.pageId.trim()) {
    citation.pageId = raw.pageId.trim();
  }
  if (typeof raw.chunkId === "string" && raw.chunkId.trim()) {
    citation.chunkId = raw.chunkId.trim();
  }
  if (typeof raw.snippet === "string" && raw.snippet.trim()) {
    citation.snippet = raw.snippet.trim();
  }

  return citation;
}

export function extractTextFromMessageJson(message: unknown): string {
  if (!isPlainObject(message)) return "";

  if (Array.isArray(message.content)) {
    const texts: string[] = [];
    for (const part of message.content) {
      if (!isPlainObject(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    if (texts.length > 0) return texts.join("");
  }

  if (Array.isArray(message.parts)) {
    const texts: string[] = [];
    for (const part of message.parts) {
      if (!isPlainObject(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    if (texts.length > 0) return texts.join("");
  }

  if (typeof message.text === "string") return message.text;
  return "";
}

export function parseCitationsFromText(raw: string): {
  bodyText: string;
  citations: ParsedCitation[];
} {
  let lastMatch: RegExpExecArray | null = null;
  const re = new RegExp(CITATIONS_FENCE_RE.source, CITATIONS_FENCE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    lastMatch = match;
  }

  let bodyText = raw;
  let citations: ParsedCitation[] = [];

  if (lastMatch) {
    const jsonBody = lastMatch[1]?.trim() ?? "";
    if (jsonBody.length > 0) {
      try {
        const parsed: unknown = JSON.parse(jsonBody);
        if (Array.isArray(parsed)) {
          const byId = new Map<number, ParsedCitation>();
          for (const item of parsed) {
            const citation = parseCitationItem(item);
            if (citation) byId.set(citation.id, citation);
          }
          citations = [...byId.values()].sort((a, b) => a.id - b.id);
        }
      } catch {
        citations = [];
      }
    }
    const start = lastMatch.index;
    const end = start + lastMatch[0].length;
    bodyText = `${raw.slice(0, start)}${raw.slice(end)}`.replace(/\s+$/, "");
  }

  return { bodyText, citations };
}

export function collectMarkerIds(text: string): number[] {
  const ids = new Set<number>();
  const re = new RegExp(CITE_MARKER_RE.source, CITE_MARKER_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const id = Number(match[1]);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Structural groundedness: do inline markers line up with the citations trailer?
 * Not an LLM factuality judge — useful as a format/compliance signal in Langfuse.
 */
export function evaluateCitationGroundedness(raw: string): CitationGroundedness {
  const { bodyText, citations } = parseCitationsFromText(raw);
  const markerIds = collectMarkerIds(bodyText);
  const trailerIds = citations.map((c) => c.id);
  const trailerSet = new Set(trailerIds);
  const markerSet = new Set(markerIds);

  const matchedIds = markerIds.filter((id) => trailerSet.has(id));
  const orphanMarkerIds = markerIds.filter((id) => !trailerSet.has(id));
  const orphanTrailerIds = trailerIds.filter((id) => !markerSet.has(id));

  const hasAnySignal = markerIds.length > 0 || trailerIds.length > 0;
  if (!hasAnySignal) {
    return {
      markerIds,
      trailerIds,
      matchedIds,
      orphanMarkerIds,
      orphanTrailerIds,
      markerCount: 0,
      trailerCount: 0,
      score: null,
      hasAnySignal: false,
    };
  }

  const denom = Math.max(markerIds.length, trailerIds.length, 1);
  let score = matchedIds.length / denom;

  // Reward complete pairs with snippets; penalize orphans.
  const withSnippet = citations.filter((c) => c.snippet && c.snippet.length > 0);
  if (citations.length > 0) {
    score = score * 0.85 + (withSnippet.length / citations.length) * 0.15;
  }
  if (orphanMarkerIds.length > 0) score *= 0.7;
  if (orphanTrailerIds.length > 0) score *= 0.9;

  score = Math.max(0, Math.min(1, score));

  return {
    markerIds,
    trailerIds,
    matchedIds,
    orphanMarkerIds,
    orphanTrailerIds,
    markerCount: markerIds.length,
    trailerCount: trailerIds.length,
    score,
    hasAnySignal: true,
  };
}

export function citationsToJsonValue(citations: ParsedCitation[]): Array<
  Record<string, string | number>
> {
  return citations.map((c) => {
    const row: Record<string, string | number> = {
      id: c.id,
      filename: c.filename,
    };
    if (c.documentId) row.documentId = c.documentId;
    if (c.pageIndex !== undefined) row.pageIndex = c.pageIndex;
    if (c.pageId) row.pageId = c.pageId;
    if (c.chunkId) row.chunkId = c.chunkId;
    if (c.snippet) row.snippet = c.snippet;
    return row;
  });
}
