import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useCitationSessionOptional } from "#/components/chat/citation-session-context";
import type { MessageCitation } from "#/lib/chat/citations";
import { validateCitationsAgainstSession } from "#/lib/chat/citations";
import { resolveDocumentIdFromCatalog } from "#/lib/documents/previewable-document";

type MessageCitationContextValue = {
  citations: MessageCitation[];
  byId: Map<number, MessageCitation>;
  /** Citation id currently hovered (chip or list item). */
  highlightedId: number | null;
  setHighlightedId: (id: number | null) => void;
  focusCitation: (citation: MessageCitation) => void;
};

const MessageCitationContext =
  createContext<MessageCitationContextValue | null>(null);

export function MessageCitationProvider({
  citations: rawCitations,
  children,
}: {
  citations: MessageCitation[];
  children: ReactNode;
}) {
  const session = useCitationSessionOptional();
  const [highlightedId, setHighlightedIdState] = useState<number | null>(null);

  const citations = useMemo(() => {
    if (!session) return rawCitations;
    return validateCitationsAgainstSession(
      rawCitations,
      session.sessionDocumentIds,
    );
  }, [rawCitations, session]);

  const byId = useMemo(
    () => new Map(citations.map((c) => [c.id, c])),
    [citations],
  );

  const setHighlightedId = useCallback((id: number | null) => {
    setHighlightedIdState(id);
  }, []);

  const focusCitation = useCallback(
    (citation: MessageCitation) => {
      setHighlightedIdState(citation.id);

      if (!session) return;

      const documentId = resolveDocumentIdFromCatalog(session.sessionDocuments, {
        documentId: citation.documentId,
        filename: citation.filename,
      });

      // Prefer resolved id; still forward original citation so pageIndex is kept.
      const resolved: MessageCitation = documentId
        ? { ...citation, documentId }
        : citation;

      // Always try session focus (handles id / fuzzy filename).
      session.focusCitationDocument(resolved);

      // Belt-and-suspenders: also open preview directly if we have an id.
      if (documentId) {
        session.openDocumentPreview({
          documentId,
          filename: citation.filename,
          pageIndex: citation.pageIndex,
        });
      }
    },
    [session],
  );

  const value = useMemo(
    () => ({
      citations,
      byId,
      highlightedId,
      setHighlightedId,
      focusCitation,
    }),
    [citations, byId, highlightedId, setHighlightedId, focusCitation],
  );

  return (
    <MessageCitationContext.Provider value={value}>
      {children}
    </MessageCitationContext.Provider>
  );
}

export function useMessageCitations() {
  return useContext(MessageCitationContext);
}
