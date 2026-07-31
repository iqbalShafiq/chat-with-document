import { useEffect, useState, type ReactNode } from "react";

export type AutoDismissPopoverProps = {
  open: boolean;
  children: ReactNode;
  /** Auto-hide duration in ms. */
  durationMs?: number;
  onDismiss?: () => void;
  className?: string;
};

/**
 * Lightweight auto-dismiss floating feedback near a control.
 * Uses role="status" + aria-live for screen readers.
 */
export function AutoDismissPopover({
  open,
  children,
  durationMs = 1800,
  onDismiss,
  className = "",
}: AutoDismissPopoverProps) {
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, durationMs);

    return () => window.clearTimeout(timer);
  }, [open, durationMs, onDismiss]);

  if (!visible) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      className={`pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-hairline bg-canvas-elevated px-2 py-1 text-[11px] font-medium text-text shadow-sm animate-fade-in ${className}`}
    >
      {children}
    </span>
  );
}
