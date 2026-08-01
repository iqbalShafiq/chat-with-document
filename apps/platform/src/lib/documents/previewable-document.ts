/** Minimal document shape accepted by the shared preview pane / modal. */
export type PreviewableDocument = {
  id: string;
  filename: string;
  mimeType?: string;
  pageCount?: number;
  sizeBytes?: number;
  firstPageSummary?: string;
};

export type DocumentPreviewOpenInput = {
  documentId: string;
  filename?: string;
  pageIndex?: number;
  mimeType?: string;
  sizeBytes?: number;
  pageCount?: number;
  firstPageSummary?: string;
};

/** Normalize filenames for fuzzy match (case / separators / extension). */
export function normalizeDocumentFilename(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(pdf|png|jpe?g|webp)$/i, "")
    .replace(/[_\s.-]+/g, "");
}

/**
 * Resolve a document id from a catalog by exact id or fuzzy filename match.
 */
export function resolveDocumentIdFromCatalog(
  catalog: Array<{ id: string; filename: string }>,
  input: { documentId?: string; filename?: string },
): string | null {
  const direct = input.documentId?.trim();
  if (direct && catalog.some((d) => d.id === direct)) return direct;
  if (direct && !input.filename) {
    // Id may still be valid even if not in the active session catalog.
    if (direct.length > 0) return direct;
  }

  const rawName = input.filename?.trim();
  if (!rawName) return direct || null;

  const exact = catalog.find((d) => d.filename === rawName);
  if (exact) return exact.id;

  const needle = normalizeDocumentFilename(rawName);
  if (!needle) return direct || null;

  const fuzzy = catalog.find((d) => {
    const candidate = normalizeDocumentFilename(d.filename);
    return (
      candidate === needle ||
      candidate.includes(needle) ||
      needle.includes(candidate)
    );
  });
  return fuzzy?.id ?? (direct && direct.length > 0 ? direct : null);
}
