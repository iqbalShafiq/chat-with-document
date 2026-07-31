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
      session?.focusCitationDocument(citation);
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
