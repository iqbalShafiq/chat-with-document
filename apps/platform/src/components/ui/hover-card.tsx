import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const DEFAULT_OPEN_DELAY_MS = 120;
const DEFAULT_CLOSE_DELAY_MS = 250;

/**
 * Reusable hover card: shows `content` in a portaled panel anchored to the
 * trigger while the pointer hovers it (or the panel itself), with a grace
 * period so interactive panels stay usable.
 *
 * - `variant: "tooltip"` — lightweight, non-interactive text bubble.
 * - `variant: "panel"` — glass popover sized for rich content (forms, editors).
 *
 * Positioning mirrors the features popover: right-aligned to the trigger,
 * flipping above when there is no room below, re-measured via ResizeObserver
 * while the panel grows. Escape and outside pointerdown dismiss it.
 */
export function HoverCard({
  content,
  variant = "tooltip",
  disabled = false,
  side = "top",
  panelClassName,
  ariaLabel,
  children,
}: {
  content: ReactNode;
  variant?: "tooltip" | "panel";
  disabled?: boolean;
  /** "top": above the anchor; "right": to the right of the anchor's container. */
  side?: "top" | "right";
  /** Extra classes for the panel (width overrides etc.). */
  panelClassName?: string;
  /** Overrides the panel's aria-label when provided. */
  ariaLabel?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    bottom: number;
    right: number;
    left: number;
  } | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const isPanelHoveredRef = useRef(false);

  const clearOpenTimer = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const handleEnter = () => {
    if (disabled) return;
    clearCloseTimer();
    openTimerRef.current = window.setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      // "right" anchors the panel to the right edge of the trigger's
      // container (the dropdown popover), with a small gap.
      const container = anchorRef.current?.parentElement;
      const containerRect = container?.getBoundingClientRect();
      setPos({
        top: rect.top,
        bottom: rect.bottom,
        right: containerRect?.right ?? rect.right,
        left: containerRect?.left ?? rect.left,
      });
      setOpen(true);
    }, DEFAULT_OPEN_DELAY_MS);
  };

  const handleLeave = () => {
    clearOpenTimer();
    if (isPanelHoveredRef.current) return;
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setPos(null);
    }, DEFAULT_CLOSE_DELAY_MS);
  };

  const handlePanelEnter = () => {
    isPanelHoveredRef.current = true;
    clearCloseTimer();
  };

  const handlePanelLeave = () => {
    isPanelHoveredRef.current = false;
    handleLeave();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setPos(null);
      }
    };
    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
      setPos(null);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !pos || !panelRef.current) return;
    const panel = panelRef.current;

    const applyPosition = () => {
      const height = panel.offsetHeight;
      const width = panel.offsetWidth;
      const gap = 8;
      if (side === "right") {
        // Right of the trigger's container (the dropdown popover).
        const left = pos.right + gap;
        const overflowRight = left + width - window.innerWidth;
        panel.style.left = `${overflowRight > 0 ? pos.left - gap - width : left}px`;
        // Align the panel's top edge with the hovered row's top edge (the
        // model being pointed at), flipping above the row near the bottom.
        const openUp = pos.top + height > window.innerHeight - 8;
        panel.style.top = `${openUp ? pos.top - height : pos.top}px`;
        panel.style.right = "auto";
        return;
      }
      const openUp = pos.top - height - gap >= 0;
      panel.style.top = `${openUp ? pos.top - height - gap : pos.bottom + gap}px`;
      panel.style.right = `${window.innerWidth - pos.right}px`;
      panel.style.left = "auto";
    };

    applyPosition();
    const observer = new ResizeObserver(applyPosition);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, pos, side]);

  useEffect(() => {
    if (disabled) {
      clearOpenTimer();
      clearCloseTimer();
      setOpen(false);
      setPos(null);
    }
  }, [disabled]);

  return (
    <>
      <span
        ref={anchorRef}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={handleEnter}
        onBlur={handleLeave}
        className="block w-full"
      >
        {children}
      </span>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role={variant === "tooltip" ? "tooltip" : "dialog"}
              aria-label={
                ariaLabel ??
                (variant === "tooltip" ? undefined : "Feature settings")
              }
              onMouseEnter={handlePanelEnter}
              onMouseLeave={handlePanelLeave}
              className={`${
                variant === "tooltip"
                  ? "fixed z-[80] max-w-[14rem] rounded-lg bg-black/85 px-2.5 py-1.5 text-[11px] leading-snug text-text shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] backdrop-blur-md animate-fade-in"
                  : "glass-popover fixed z-[80] w-[17rem] rounded-2xl p-2.5 text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-scale-in"
              }${panelClassName ? ` ${panelClassName}` : ""}`}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
