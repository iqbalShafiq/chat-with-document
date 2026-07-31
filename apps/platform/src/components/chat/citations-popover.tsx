import type { RefObject } from "react";
import {
  CitationSourceItem,
  CitationSourcesPanel,
} from "#/components/chat/citation-source-item";
import { useMessageCitations } from "#/components/chat/message-citation-context";
import type { MessageCitation } from "#/lib/chat/citations";

export type CitationsPopoverProps = {
  citations: MessageCitation[];
  id?: string;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

export function CitationsPopover({
  citations,
  id,
  anchorRef,
  panelRef,
  onMouseEnter,
  onMouseLeave,
}: CitationsPopoverProps) {
  const messageCtx = useMessageCitations();
  if (citations.length === 0) return null;

  const list = messageCtx?.citations ?? citations;

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
            onMouseEnter={() => messageCtx?.setHighlightedId(citation.id)}
            onMouseLeave={() => {
              if (messageCtx?.highlightedId === citation.id) {
                messageCtx.setHighlightedId(null);
              }
            }}
            onClick={() => messageCtx?.focusCitation(citation)}
          />
        );
      })}
    </CitationSourcesPanel>
  );
}
