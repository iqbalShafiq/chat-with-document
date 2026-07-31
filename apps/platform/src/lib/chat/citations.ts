export type MessageCitation = {
  id: number;
  documentId?: string;
  filename: string;
  /** 0-based page index from tools. */
  pageIndex?: number;
  pageId?: string;
  chunkId?: string;
  snippet?: string;
  /**
   * Soft validation against current session documents.
   * undefined = not validated; false = documentId unknown in session.
   */
  inSession?: boolean;
};

export type ParsedCitations = {
  /** Body with citations fence removed; inline markers still present. */
  bodyText: string;
  citations: MessageCitation[];
  byId: Map<number, MessageCitation>;
};

/** Complete inline marker: [[cite:12]] */
export const CITE_MARKER_RE = /\[\[cite:(\d+)\]\]/g;

/** Incomplete marker while streaming (no closing ]] yet). */
const INCOMPLETE_CITE_RE = /\[\[cite:(?:\d+)?$/;

/** Fenced ```citations ... ``` block (prefer last match). */
const CITATIONS_FENCE_RE =
  /```citations\s*\r?\n([\s\S]*?)```/gi;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCitationItem(raw: unknown): MessageCitation | null {
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

  const citation: MessageCitation = { id, filename };

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
  if (typeof raw.inSession === "boolean") {
    citation.inSession = raw.inSession;
  }

  return citation;
}

function extractCitationsFence(text: string): {
  bodyText: string;
  citations: MessageCitation[];
} {
  let lastMatch: RegExpExecArray | null = null;
  const re = new RegExp(CITATIONS_FENCE_RE.source, CITATIONS_FENCE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return { bodyText: text, citations: [] };
  }

  const jsonBody = lastMatch[1]?.trim() ?? "";
  let citations: MessageCitation[] = [];

  if (jsonBody.length > 0) {
    try {
      const parsed: unknown = JSON.parse(jsonBody);
      if (Array.isArray(parsed)) {
        const byId = new Map<number, MessageCitation>();
        for (const item of parsed) {
          const citation = parseCitationItem(item);
          if (citation) byId.set(citation.id, citation);
        }
        citations = [...byId.values()].sort((a, b) => a.id - b.id);
      }
    } catch {
      // Incomplete or invalid JSON while streaming — treat as no sources yet.
      citations = [];
    }
  }

  const start = lastMatch.index;
  const end = start + lastMatch[0].length;
  let bodyText = `${text.slice(0, start)}${text.slice(end)}`;
  // Trim trailing whitespace left by the fence, keep leading body intact.
  bodyText = bodyText.replace(/\s+$/, "");

  return { bodyText, citations };
}

/**
 * Parse assistant message text into body + structured citations.
 * Safe to call on partial streamed text.
 */
export function parseMessageCitations(raw: string): ParsedCitations {
  const { bodyText, citations } = extractCitationsFence(raw);
  const byId = new Map(citations.map((c) => [c.id, c]));
  return { bodyText, citations, byId };
}

/** Parse citations array from message metadata (server dual-write). */
export function parseCitationsFromMetadata(
  metadata: unknown,
): MessageCitation[] | null {
  if (!isPlainObject(metadata)) return null;
  if (!Array.isArray(metadata.citations)) return null;

  const byId = new Map<number, MessageCitation>();
  for (const item of metadata.citations) {
    const citation = parseCitationItem(item);
    if (citation) byId.set(citation.id, citation);
  }
  if (byId.size === 0) return [];
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Prefer metadata dual-write when available; fall back to parsing raw text.
 */
export function resolveMessageCitations(opts: {
  rawText: string;
  metadata?: unknown;
}): ParsedCitations {
  const fromMeta = parseCitationsFromMetadata(opts.metadata);
  if (fromMeta !== null && fromMeta.length > 0) {
    const { bodyText } = extractCitationsFence(opts.rawText);
    return {
      bodyText,
      citations: fromMeta,
      byId: new Map(fromMeta.map((c) => [c.id, c])),
    };
  }
  return parseMessageCitations(opts.rawText);
}

/** Soft-validate citations against known session document ids. */
export function validateCitationsAgainstSession(
  citations: MessageCitation[],
  sessionDocumentIds: ReadonlySet<string>,
): MessageCitation[] {
  if (sessionDocumentIds.size === 0) {
    return citations.map((c) =>
      c.documentId
        ? { ...c, inSession: undefined }
        : { ...c, inSession: undefined },
    );
  }

  return citations.map((c) => {
    if (!c.documentId) return { ...c, inSession: undefined };
    return { ...c, inSession: sessionDocumentIds.has(c.documentId) };
  });
}

/** Human-facing page label from 0-based pageIndex. */
export function formatCitationPageLabel(
  pageIndex: number | undefined,
): string | null {
  if (pageIndex === undefined || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return null;
  }
  return `Page ${pageIndex + 1}`;
}

/**
 * Hide incomplete streaming markers and drop complete markers when stripping
 * for copy. Also removes the citations fence.
 */
export function stripCitationsForCopy(raw: string): string {
  const { bodyText } = extractCitationsFence(raw);
  return bodyText
    .replace(CITE_MARKER_RE, "")
    .replace(INCOMPLETE_CITE_RE, "")
    // "12% [[cite:1]]," → "12% ," → "12%,"
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Markdown link target for citation chips.
 * Use hash URLs (`#cite-N`) — react-markdown's defaultUrlTransform strips
 * custom schemes like `app-cite:`, which left bare clickable <a> tags.
 */
export const CITE_HREF_PREFIX = "#cite-";
export const CITE_PENDING_HREF = "#cite-pending";
/** Legacy scheme kept for detection if any old content is still in flight. */
const CITE_HREF_PREFIX_LEGACY = "app-cite:";

export function isPendingCitationHref(
  href: string | undefined | null,
): boolean {
  return (
    href === CITE_PENDING_HREF || href === `${CITE_HREF_PREFIX_LEGACY}pending`
  );
}

export function isCitationHref(href: string | undefined | null): href is string {
  if (typeof href !== "string") return false;
  if (isPendingCitationHref(href)) return true;
  return (
    href.startsWith(CITE_HREF_PREFIX) ||
    href.startsWith(CITE_HREF_PREFIX_LEGACY)
  );
}

export function citationIdFromHref(href: string): number | null {
  if (!isCitationHref(href) || isPendingCitationHref(href)) return null;
  const raw = href.startsWith(CITE_HREF_PREFIX)
    ? href.slice(CITE_HREF_PREFIX.length)
    : href.startsWith(CITE_HREF_PREFIX_LEGACY)
      ? href.slice(CITE_HREF_PREFIX_LEGACY.length)
      : "";
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/**
 * Prepare markdown body for render:
 * - strip citations fence
 * - incomplete trailing [[cite: → pending chip link
 * - complete markers → markdown links → CitationChip
 */
export function prepareCitationMarkdown(raw: string): {
  markdown: string;
  citations: MessageCitation[];
  byId: Map<number, MessageCitation>;
} {
  const { bodyText, citations, byId } = parseMessageCitations(raw);

  let markdown = bodyText.replace(CITE_MARKER_RE, (_m, id: string) => {
    return `[${id}](${CITE_HREF_PREFIX}${id})`;
  });

  // Streaming placeholder for incomplete markers (ghost chip).
  markdown = markdown.replace(
    INCOMPLETE_CITE_RE,
    `[…](${CITE_PENDING_HREF})`,
  );

  // Hide incomplete citations fence while streaming (opened but not closed).
  markdown = markdown
    .replace(/```citations\s*\r?\n[\s\S]*$/i, "")
    .replace(/\s+$/, "");

  return { markdown, citations, byId };
}

/** Serialize citations for message.metadata dual-write on the client. */
export function citationsToMetadataValue(
  citations: MessageCitation[],
): Array<Record<string, string | number | boolean>> {
  return citations.map((c) => {
    const row: Record<string, string | number | boolean> = {
      id: c.id,
      filename: c.filename,
    };
    if (c.documentId) row.documentId = c.documentId;
    if (c.pageIndex !== undefined) row.pageIndex = c.pageIndex;
    if (c.pageId) row.pageId = c.pageId;
    if (c.chunkId) row.chunkId = c.chunkId;
    if (c.snippet) row.snippet = c.snippet;
    if (c.inSession !== undefined) row.inSession = c.inSession;
    return row;
  });
}
