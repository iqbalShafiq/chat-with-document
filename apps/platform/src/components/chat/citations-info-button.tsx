import { Info } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CitationsPopover } from "#/components/chat/citations-popover";
import type { MessageCitation } from "#/lib/chat/citations";

const ACTION_ICON_CLASS =
  "inline-flex cursor-pointer p-0 text-text-faint transition hover:text-text active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";

export type CitationsInfoButtonProps = {
  citations: MessageCitation[];
};

/**
 * Info control left of copy on assistant messages.
 * Opens sources popover on hover (fine pointer) and click/focus (touch + a11y).
 */
export function CitationsInfoButton({ citations }: CitationsInfoButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const closeTimer = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  }, [clearCloseTimer]);

  const openNow = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  useEffect(() => {
    return () => clearCloseTimer();
  }, [clearCloseTimer]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (citations.length === 0) return null;

  const countLabel =
    citations.length === 1 ? "1 source" : `${citations.length} sources`;

  return (
    <span
      ref={rootRef}
      className="relative inline-flex"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={ACTION_ICON_CLASS}
        aria-label={`Sources used (${countLabel})`}
        aria-expanded={open}
        aria-controls={panelId}
        title={countLabel}
        onClick={() => setOpen((prev) => !prev)}
        onFocus={openNow}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && rootRef.current?.contains(next)) return;
          if (next instanceof Node && panelRef.current?.contains(next)) return;
          scheduleClose();
        }}
      >
        <Info className="size-4" strokeWidth={1.75} />
      </button>
      {open ? (
        <CitationsPopover
          id={panelId}
          citations={citations}
          anchorRef={rootRef}
          panelRef={panelRef}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
        />
      ) : null}
    </span>
  );
}
