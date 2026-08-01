import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DocumentPreviewModal } from "#/components/documents/document-preview-modal";
import type { SessionDocument } from "#/lib/api";
import type { MessageCitation } from "#/lib/chat/citations";
import type {
  DocumentPreviewOpenInput,
  PreviewableDocument,
} from "#/lib/documents/previewable-document";
import { resolveDocumentIdFromCatalog } from "#/lib/documents/previewable-document";

export type DocumentFocusTarget = {
  documentId: string;
  filename?: string;
  pageIndex?: number;
  citationId?: number;
  /** Bumps to re-trigger scroll/highlight even for same doc. */
  nonce: number;
};

export type DocumentPreviewTarget = {
  documentId: string;
  filename: string;
  pageIndex?: number;
  mimeType?: string;
  sizeBytes?: number;
  pageCount?: number;
  firstPageSummary?: string;
  nonce: number;
};

type CitationSessionContextValue = {
  sessionDocuments: SessionDocument[];
  sessionDocumentIds: ReadonlySet<string>;
  focusTarget: DocumentFocusTarget | null;
  focusCitationDocument: (citation: MessageCitation) => void;
  clearDocumentFocus: () => void;
  /** Open shared document preview modal (optionally on a page). */
  openDocumentPreview: (input: DocumentPreviewOpenInput) => void;
  closeDocumentPreview: () => void;
  previewTarget: DocumentPreviewTarget | null;
};

const CitationSessionContext =
  createContext<CitationSessionContextValue | null>(null);

export function CitationSessionProvider({
  sessionDocuments,
  children,
}: {
  sessionDocuments: SessionDocument[];
  children: ReactNode;
}) {
  const [focusTarget, setFocusTarget] = useState<DocumentFocusTarget | null>(
    null,
  );
  const [previewTarget, setPreviewTarget] =
    useState<DocumentPreviewTarget | null>(null);

  const sessionDocumentIds = useMemo(
    () => new Set(sessionDocuments.map((d) => d.id)),
    [sessionDocuments],
  );

  const openDocumentPreview = useCallback(
    (input: DocumentPreviewOpenInput) => {
      const resolvedId =
        resolveDocumentIdFromCatalog(sessionDocuments, {
          documentId: input.documentId,
          filename: input.filename,
        }) ?? input.documentId?.trim();

      if (!resolvedId) return;

      const sessionDoc = sessionDocuments.find((d) => d.id === resolvedId);

      setPreviewTarget({
        documentId: resolvedId,
        filename:
          input.filename?.trim() ||
          sessionDoc?.filename ||
          resolvedId,
        ...(typeof input.pageIndex === "number" && input.pageIndex >= 0
          ? { pageIndex: input.pageIndex }
          : {}),
        ...(input.mimeType || sessionDoc?.mimeType
          ? { mimeType: input.mimeType || sessionDoc?.mimeType }
          : {}),
        ...(typeof input.sizeBytes === "number" ||
        typeof sessionDoc?.sizeBytes === "number"
          ? {
              sizeBytes:
                typeof input.sizeBytes === "number"
                  ? input.sizeBytes
                  : sessionDoc!.sizeBytes!,
            }
          : {}),
        ...(typeof input.pageCount === "number" ||
        typeof sessionDoc?.pageCount === "number"
          ? {
              pageCount:
                typeof input.pageCount === "number"
                  ? input.pageCount
                  : sessionDoc!.pageCount!,
            }
          : {}),
        ...(input.firstPageSummary || sessionDoc?.firstPageSummary
          ? {
              firstPageSummary:
                input.firstPageSummary || sessionDoc?.firstPageSummary,
            }
          : {}),
        nonce: Date.now(),
      });
    },
    [sessionDocuments],
  );

  const closeDocumentPreview = useCallback(() => {
    setPreviewTarget(null);
  }, []);

  const focusCitationDocument = useCallback(
    (citation: MessageCitation) => {
      const documentId = resolveDocumentIdFromCatalog(sessionDocuments, {
        documentId: citation.documentId,
        filename: citation.filename,
      });
      if (!documentId) return;

      setFocusTarget({
        documentId,
        filename: citation.filename,
        pageIndex: citation.pageIndex,
        citationId: citation.id,
        nonce: Date.now(),
      });
      openDocumentPreview({
        documentId,
        filename: citation.filename,
        pageIndex: citation.pageIndex,
      });
    },
    [openDocumentPreview, sessionDocuments],
  );

  const clearDocumentFocus = useCallback(() => {
    setFocusTarget(null);
  }, []);

  const value = useMemo(
    () => ({
      sessionDocuments,
      sessionDocumentIds,
      focusTarget,
      focusCitationDocument,
      clearDocumentFocus,
      openDocumentPreview,
      closeDocumentPreview,
      previewTarget,
    }),
    [
      sessionDocuments,
      sessionDocumentIds,
      focusTarget,
      focusCitationDocument,
      clearDocumentFocus,
      openDocumentPreview,
      closeDocumentPreview,
      previewTarget,
    ],
  );

  const previewDocument: PreviewableDocument | null = previewTarget
    ? {
        id: previewTarget.documentId,
        filename: previewTarget.filename,
        ...(previewTarget.mimeType
          ? { mimeType: previewTarget.mimeType }
          : {}),
        ...(typeof previewTarget.sizeBytes === "number"
          ? { sizeBytes: previewTarget.sizeBytes }
          : {}),
        ...(typeof previewTarget.pageCount === "number"
          ? { pageCount: previewTarget.pageCount }
          : {}),
        ...(previewTarget.firstPageSummary
          ? { firstPageSummary: previewTarget.firstPageSummary }
          : {}),
      }
    : null;

  return (
    <CitationSessionContext.Provider value={value}>
      {children}
      <DocumentPreviewModal
        open={previewTarget != null}
        document={previewDocument}
        initialPageIndex={previewTarget?.pageIndex ?? 0}
        instanceKey={previewTarget?.nonce}
        onClose={closeDocumentPreview}
      />
    </CitationSessionContext.Provider>
  );
}

export function useCitationSession() {
  const ctx = useContext(CitationSessionContext);
  if (!ctx) {
    throw new Error(
      "useCitationSession must be used within CitationSessionProvider",
    );
  }
  return ctx;
}

/** Safe optional access when outside provider (e.g. isolated stories). */
export function useCitationSessionOptional() {
  return useContext(CitationSessionContext);
}
