import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * @deprecated Kept for call-site compatibility. Confirm always uses the
   * same primary (accent) treatment as the chat send button.
   */
  variant?: "danger" | "accent";
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Element to restore focus to when the dialog closes. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
};

/** Matches Composer.Submit (send) primary treatment. */
const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-9 cursor-pointer items-center rounded-xl bg-accent px-3.5 text-sm font-medium text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Accessible modal confirm dialog using the native <dialog> + showModal()
 * (focus trap, Esc, aria-modal behavior per HTML / WAI-ARIA APG).
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  variant: _variant = "accent",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  restoreFocusRef,
}: ConfirmDialogProps) {
  void _variant;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
      // Prefer cancel as initial focus (safer default for destructive actions).
      requestAnimationFrame(() => {
        cancelRef.current?.focus();
      });
      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [open]);

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
      className="confirm-dialog m-auto w-[min(100%,24rem)] rounded-2xl border border-hairline bg-canvas-elevated p-0 text-text shadow-[0_24px_64px_-16px_rgba(0,0,0,0.65)] backdrop:bg-black/55 open:flex open:flex-col"
      aria-labelledby={titleId}
      aria-describedby={
        error ? `${descriptionId} ${errorId}` : descriptionId
      }
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        // Backdrop click (dialog itself, not panel) cancels.
        if (event.target === dialogRef.current && !busy) {
          onCancel();
        }
      }}
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-2">
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <div
            id={descriptionId}
            className="text-sm leading-relaxed text-text-muted"
          >
            {description}
          </div>
          {error ? (
            <p id={errorId} className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="inline-flex min-h-9 cursor-pointer items-center rounded-xl px-3.5 text-sm font-medium text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/8 hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
