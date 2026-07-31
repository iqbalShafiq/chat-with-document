import {
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { MessageCitation } from "#/lib/chat/citations";
import { formatCitationPageLabel } from "#/lib/chat/citations";

/** Above sidebar (z-40), top bar, composer dock, and chat chrome. */
export const CITATION_POPOVER_Z_INDEX = 9999;

export type CitationSourceItemProps = {
  citation: MessageCitation;
  highlighted?: boolean;
  /** When true, render as a non-interactive row (chip hover preview). */
  static?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: () => void;
};

/**
 * Single source row — shared by the multi-source popover and the
 * inline-chip hover preview so typography/colors stay identical.
 */
export function CitationSourceItem({
  citation,
  highlighted = false,
  static: isStatic = false,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: CitationSourceItemProps) {
  const page = formatCitationPageLabel(citation.pageIndex);
  const outOfSession = citation.inSession === false;
  const clickable = Boolean(citation.documentId) && !isStatic;

  const body = (
    <>
      <span
        className={[
          "mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center",
          "rounded-full px-1 text-[10px] font-semibold tabular-nums",
          "ring-1",
          outOfSession
            ? "bg-danger-soft text-danger ring-danger/30"
            : "bg-accent-soft text-accent ring-accent-ring/40",
        ].join(" ")}
      >
        {citation.id}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-text">
          {citation.filename}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted">
          {page ? <span>{page}</span> : null}
          {outOfSession ? (
            <span className="text-danger">Not in session</span>
          ) : null}
        </div>
        {citation.snippet ? (
          <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-text-faint">
            {citation.snippet}
          </p>
        ) : null}
      </div>
    </>
  );

  const rowClass = [
    "flex w-full gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
    isStatic
      ? "cursor-default"
      : [
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring",
          clickable ? "cursor-pointer" : "cursor-default",
          highlighted
            ? "bg-accent-soft/60 ring-1 ring-accent-ring/30"
            : "hover:bg-white/[0.04]",
        ].join(" "),
  ].join(" ");

  if (isStatic) {
    return (
      <div className={rowClass} data-citation-id={citation.id}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      role="listitem"
      data-citation-id={citation.id}
      disabled={!clickable}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      className={rowClass}
    >
      {body}
    </button>
  );
}

export type CitationSourcesPanelProps = {
  id?: string;
  title?: string;
  children: ReactNode;
  className?: string;
  align?: "left" | "center";
  /** Anchor element used to position the portaled panel (fixed). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Optional panel ref for outside-click / hover bridging. */
  panelRef?: RefObject<HTMLDivElement | null>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

/**
 * Shared chrome for the sources popover panel.
 * Portaled to document.body with a top-tier z-index so it stacks above
 * sidebar, top bar, composer, and scroll containers.
 */
export function CitationSourcesPanel({
  id,
  title = "Sources",
  children,
  className = "",
  align = "left",
  anchorRef,
  panelRef,
  onMouseEnter,
  onMouseLeave,
}: CitationSourcesPanelProps) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCoords({
        top: rect.top,
        left:
          align === "center" ? rect.left + rect.width / 2 : rect.left,
      });
    };

    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorRef, align]);

  if (typeof document === "undefined" || !coords) return null;

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="list"
      aria-label={title}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed",
        top: coords.top - 6,
        left: coords.left,
        transform:
          align === "center" ? "translate(-50%, -100%)" : "translateY(-100%)",
        zIndex: CITATION_POPOVER_Z_INDEX,
      }}
      className={[
        "w-[min(20rem,calc(100vw-2rem))] animate-fade-in",
        "rounded-xl border border-hairline bg-canvas-elevated/95 p-1.5 shadow-lg",
        "backdrop-blur-md",
        className,
      ].join(" ")}
    >
      <div className="chat-scroll max-h-64 space-y-1 overflow-y-auto overscroll-contain px-0.5 py-0.5">
        <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-text-faint">
          {title}
        </p>
        {children}
      </div>
    </div>,
    document.body,
  );
}
