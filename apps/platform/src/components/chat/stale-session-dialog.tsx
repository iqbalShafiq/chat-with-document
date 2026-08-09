import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_SECONDARY_BUTTON_CLASS } from "#/components/ui/dialog-actions";
import { RefreshCw } from "lucide-react";

/**
 * Shown before sending when the server memory has MORE messages than the
 * local view knows about (the conversation changed in another window or
 * device). For a normal send the user may proceed anyway; for resubmit /
 * revert the action is destructive (it would delete the newer messages), so
 * only Reload is offered.
 */
export function StaleSessionDialog({
  open,
  kind,
  onReload,
  onSendAnyway,
}: {
  open: boolean;
  kind: "send" | "resubmit";
  onReload: () => void;
  onSendAnyway?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      }
      reloadRef.current?.focus();
    } else {
      dialogRef.current?.close();
    }
  }, [open]);

  if (!open) return null;

  const destructive = kind === "resubmit";

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="stale-session-dialog-title"
      className="m-auto w-[min(100%-1.5rem,26rem)] rounded-2xl border border-hairline bg-canvas-elevated p-5 text-text shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)] backdrop:bg-black/55 open:flex open:flex-col open:gap-3 animate-scale-in"
      onCancel={(event) => {
        event.preventDefault();
        onReload();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onReload();
      }}
    >
      <div className="flex flex-col gap-1">
        <h2
          id="stale-session-dialog-title"
          className="text-sm font-semibold tracking-tight"
        >
          Conversation updated elsewhere
        </h2>
        <p className="text-xs leading-relaxed text-text-muted">
          {destructive ? (
            <>
              This conversation has newer messages from another window or
              device. Resubmitting would replace those newer messages. Reload
              the conversation to see the latest state before editing again.
            </>
          ) : (
            <>
              This conversation has newer messages from another window or
              device. Reload to see them, or send anyway — your message will be
              appended to the latest conversation.
            </>
          )}
        </p>
      </div>

      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          ref={reloadRef}
          type="button"
          onClick={onReload}
          className={DIALOG_PRIMARY_BUTTON_CLASS}
        >
          <RefreshCw className="size-3.5" strokeWidth={2} />
          Reload conversation
        </button>
        {!destructive && onSendAnyway ? (
          <button
            type="button"
            onClick={onSendAnyway}
            className={DIALOG_SECONDARY_BUTTON_CLASS}
          >
            Send anyway
          </button>
        ) : null}
      </div>
    </dialog>,
    document.body,
  );
}
