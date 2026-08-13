import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import type { ContextSnippet } from "#/lib/api";
import { HoverCard } from "#/components/ui/hover-card";

const SOURCE_LABEL: Record<ContextSnippet["sourceRole"], string> = {
  user: "from your message",
  assistant: "from the assistant",
};

/**
 * Reusable snippet card: line-clamped text with expand/collapse and a hover
 * popover showing the full text. `variant: "composer"` adds a remove button;
 * `variant: "bubble"` is the read-only form rendered inside a sent user bubble.
 */
export function ContextSnippetChip({
  snippet,
  variant,
  removing = false,
  onRemove,
}: {
  snippet: ContextSnippet;
  variant: "composer" | "bubble";
  removing?: boolean;
  onRemove?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      data-testid="context-snippet-chip"
      className={`group/snippet min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.04] transition duration-200 ${
        variant === "composer"
          ? "animate-fade-in p-2"
          : "mb-2 px-3 py-2"
      } ${removing ? "animate-fade-out" : ""}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-text-faint">
            <span>Additional context</span>
            <span aria-hidden>·</span>
            <span className="truncate">{SOURCE_LABEL[snippet.sourceRole]}</span>
          </div>
          <HoverCard
            side="top"
            variant="panel"
            panelClassName="w-[min(24rem,90vw)]"
            content={
              <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-text-muted">
                {snippet.text}
              </p>
            }
          >
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className="block w-full cursor-pointer text-left"
            >
              <span
                className={`block whitespace-pre-wrap break-words text-xs leading-relaxed text-text transition-[max-height,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                  expanded ? "max-h-96 overflow-y-auto opacity-100" : "line-clamp-2 max-h-10 opacity-90"
                }`}
              >
                {snippet.text}
              </span>
            </button>
          </HoverCard>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={expanded ? "Collapse context" : "Expand context"}
            title={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((current) => !current)}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-white/[0.06] hover:text-text active:scale-[0.94]"
          >
            {expanded ? (
              <ChevronUp className="size-3.5" strokeWidth={2} />
            ) : (
              <ChevronDown className="size-3.5" strokeWidth={2} />
            )}
          </button>
          {variant === "composer" && onRemove ? (
            <button
              type="button"
              aria-label="Remove context"
              title="Remove"
              onClick={onRemove}
              disabled={removing}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-white/[0.06] hover:text-text active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="size-3.5" strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
