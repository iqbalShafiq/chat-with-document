import { useId, useRef, useState } from "react";
import {
  CitationSourceItem,
  CitationSourcesPanel,
} from "#/components/chat/citation-source-item";
import { useMessageCitations } from "#/components/chat/message-citation-context";
import type { MessageCitation } from "#/lib/chat/citations";
import { formatCitationPageLabel } from "#/lib/chat/citations";

export type CitationChipProps = {
  id: number;
  citation?: MessageCitation;
  pending?: boolean;
};

/**
 * Inline citation marker in message text.
 * Text-only superscript (no pill/container). Hover shows a single-source
 * popover; click opens the document preview modal on the cited page.
 */
export function CitationChip({ id, citation, pending = false }: CitationChipProps) {
  const messageCtx = useMessageCitations();
  const resolved = citation ?? messageCtx?.byId.get(id);
  const highlighted = messageCtx?.highlightedId === id;
  const [hoverOpen, setHoverOpen] = useState(false);
  const tipId = useId();
  const anchorRef = useRef<HTMLElement>(null);

  if (pending) {
    return (
      <span className="citation-chip relative top-[-0.4em] ml-px inline-block cursor-pointer text-[0.9em] tabular-nums leading-none text-text-faint animate-pulse">
        …
      </span>
    );
  }

  const page = formatCitationPageLabel(resolved?.pageIndex);
  const label = resolved
    ? [resolved.filename, page].filter(Boolean).join(" · ")
    : `Source ${id}`;
  const known = resolved !== undefined;
  const outOfSession = resolved?.inSession === false;
  // focusCitation resolves documentId from the session catalog when missing.
  const canOpen = Boolean(resolved);
  const showPreview = hoverOpen && resolved;

  const openPreview = () => {
    if (!resolved) return;
    messageCtx?.focusCitation(resolved);
  };

  return (
    <span
      ref={anchorRef}
      className="citation-chip relative top-[-0.4em] ml-px inline-block cursor-pointer"
      onMouseEnter={() => {
        setHoverOpen(true);
        messageCtx?.setHighlightedId(id);
      }}
      onMouseLeave={() => {
        setHoverOpen(false);
        if (messageCtx?.highlightedId === id) {
          messageCtx.setHighlightedId(null);
        }
      }}
    >
      <button
        type="button"
        aria-label={
          canOpen ? `Open preview for ${label}` : label
        }
        aria-describedby={showPreview ? tipId : undefined}
        disabled={!canOpen}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openPreview();
        }}
        className={[
          // Text-only: no background, ring, or padding — raised slightly (not full super).
          "cursor-pointer select-none border-0 bg-transparent p-0 text-[0.9em] font-semibold tabular-nums leading-none no-underline",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:underline focus-visible:decoration-accent/60",
          known && !outOfSession
            ? "text-accent"
            : outOfSession
              ? "text-danger"
              : "text-text-faint",
          highlighted ? "underline decoration-accent/50 underline-offset-2" : "",
          !canOpen ? "cursor-default" : "",
        ].join(" ")}
      >
        {id}
      </button>

      {showPreview ? (
        <CitationSourcesPanel
          id={tipId}
          title="Source"
          align="center"
          anchorRef={anchorRef}
          className="pointer-events-none"
        >
          <CitationSourceItem citation={resolved} static />
        </CitationSourcesPanel>
      ) : null}
    </span>
  );
}
