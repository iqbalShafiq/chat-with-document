import type { RefObject } from "react";
import {
  CitationSourceItem,
  CitationSourcesPanel,
} from "#/components/chat/citation-source-item";
import { useCitationSessionOptional } from "#/components/chat/citation-session-context";
import { useMessageCitations } from "#/components/chat/message-citation-context";
import type { MessageCitation } from "#/lib/chat/citations";

export type CitationsPopoverProps = {
  citations: MessageCitation[];
  id?: string;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Called after a source is activated (e.g. close the popover). */
  onSourceActivate?: () => void;
};

export function CitationsPopover({
  citations,
  id,
  anchorRef,
  panelRef,
  onMouseEnter,
  onMouseLeave,
  onSourceActivate,
}: CitationsPopoverProps) {
  const messageCtx = useMessageCitations();
  const session = useCitationSessionOptional();
  if (citations.length === 0) return null;

  const list = messageCtx?.citations ?? citations;

  const activate = (citation: MessageCitation) => {
    // Prefer message context (highlight + resolve + open).
    if (messageCtx) {
      messageCtx.focusCitation(citation);
    } else if (session) {
      session.focusCitationDocument(citation);
    }
    onSourceActivate?.();
  };

  return (
    <CitationSourcesPanel
      id={id}
      title="Sources"
      anchorRef={anchorRef}
      panelRef={panelRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {list.map((citation) => {
        const highlighted = messageCtx?.highlightedId === citation.id;
        return (
          <CitationSourceItem
            key={citation.id}
            citation={citation}
            highlighted={highlighted}
            // Always interactive — ids resolved on click from session catalog.
            forceClickable
            onMouseEnter={() => messageCtx?.setHighlightedId(citation.id)}
            onMouseLeave={() => {
              if (messageCtx?.highlightedId === citation.id) {
                messageCtx.setHighlightedId(null);
              }
            }}
            onClick={() => activate(citation)}
          />
        );
      })}
    </CitationSourcesPanel>
  );
}
