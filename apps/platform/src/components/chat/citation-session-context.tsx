import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SessionDocument } from "#/lib/api";
import type { MessageCitation } from "#/lib/chat/citations";

export type DocumentFocusTarget = {
  documentId: string;
  filename?: string;
  pageIndex?: number;
  citationId?: number;
  /** Bumps to re-trigger scroll/highlight even for same doc. */
  nonce: number;
};

type CitationSessionContextValue = {
  sessionDocuments: SessionDocument[];
  sessionDocumentIds: ReadonlySet<string>;
  focusTarget: DocumentFocusTarget | null;
  focusCitationDocument: (citation: MessageCitation) => void;
  clearDocumentFocus: () => void;
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

  const sessionDocumentIds = useMemo(
    () => new Set(sessionDocuments.map((d) => d.id)),
    [sessionDocuments],
  );

  const focusCitationDocument = useCallback((citation: MessageCitation) => {
    if (!citation.documentId) return;
    setFocusTarget({
      documentId: citation.documentId,
      filename: citation.filename,
      pageIndex: citation.pageIndex,
      citationId: citation.id,
      nonce: Date.now(),
    });
  }, []);

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
    }),
    [
      sessionDocuments,
      sessionDocumentIds,
      focusTarget,
      focusCitationDocument,
      clearDocumentFocus,
    ],
  );

  return (
    <CitationSessionContext.Provider value={value}>
      {children}
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
