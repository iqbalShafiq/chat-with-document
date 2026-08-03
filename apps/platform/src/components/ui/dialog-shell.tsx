import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

export type DialogShellProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Footer actions row (optional). */
  footer?: ReactNode;
  /** Extra class on the dialog element. */
  className?: string;
  /** Max width utility, default wide library/settings style. */
  size?: "sm" | "md" | "lg" | "xl";
  /**
   * viewport — fixed tall panel (library / settings).
   * content — height follows children (compact forms).
   */
  heightMode?: "viewport" | "content";
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Preferred initial focus when the dialog opens (e.g. first field).
   * Falls back to the close control.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Disable Esc / backdrop dismiss (e.g. while busy). */
  dismissDisabled?: boolean;
  /** Optional subtitle under the title. */
  description?: ReactNode;
};

const SIZE_CLASS: Record<NonNullable<DialogShellProps["size"]>, string> = {
  sm: "w-[min(100%-1.5rem,24rem)]",
  md: "w-[min(100%-1.5rem,32rem)]",
  lg: "w-[min(100%-1.5rem,42rem)]",
  xl: "w-[min(100%-1.5rem,56rem)]",
};

const HEIGHT_CLASS: Record<
  NonNullable<DialogShellProps["heightMode"]>,
  string
> = {
  viewport: "h-[min(80dvh,44rem)] max-h-[min(90dvh,52rem)]",
  content: "h-auto max-h-[min(90dvh,40rem)]",
};

/**
 * Shared accessible modal shell using native `<dialog showModal()>`.
 * Provides focus trap, Esc, backdrop dismiss, and labelled chrome (APG).
 */
export function DialogShell({
  open,
  onClose,
  title,
  children,
  footer,
  className = "",
  size = "lg",
  heightMode = "viewport",
  restoreFocusRef,
  initialFocusRef,
  dismissDisabled = false,
  description,
}: DialogShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => {
        const preferred = initialFocusRef?.current;
        if (preferred && typeof preferred.focus === "function") {
          preferred.focus();
          return;
        }
        closeRef.current?.focus();
      });
      return;
    }
    if (dialog.open) dialog.close();
  }, [open, initialFocusRef]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      restoreFocusRef?.current?.focus();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [restoreFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      className={`m-auto overflow-hidden rounded-2xl border border-hairline bg-canvas-elevated p-0 text-text shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)] backdrop:bg-black/55 open:flex open:flex-col animate-scale-in ${HEIGHT_CLASS[heightMode]} ${SIZE_CLASS[size]} ${className}`}
      style={{ transformOrigin: "center center" }}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!dismissDisabled) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !dismissDisabled) {
          onClose();
        }
      }}
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="truncate text-sm font-semibold tracking-tight text-text"
          >
            {title}
          </h2>
          {description ? (
            <div
              id={descriptionId}
              className="truncate text-[11px] text-text-faint"
            >
              {description}
            </div>
          ) : null}
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close"
          onClick={onClose}
          disabled={dismissDisabled}
          className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span aria-hidden className="text-lg leading-none">
            ×
          </span>
        </button>
      </div>

      <div
        className={
          heightMode === "content"
            ? "flex flex-col overflow-y-auto"
            : "flex min-h-0 flex-1 flex-col overflow-hidden"
        }
      >
        {children}
      </div>

      {footer ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
