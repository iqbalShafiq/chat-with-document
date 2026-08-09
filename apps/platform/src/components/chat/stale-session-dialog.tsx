import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { DIALOG_PRIMARY_BUTTON_CLASS } from "#/components/ui/dialog-actions";
import { RefreshCw } from "lucide-react";

/**
 * Freshness notice for a conversation that changed in another window/device.
 * For a normal send the message went through (non-destructive) — this is a
 * non-blocking "reload to catch up" notice. For resubmit / revert the action
 * would delete the newer messages, so it is blocked until reload.
 */
export function StaleSessionDialog({
  open,
  kind,
  onReload,
}: {
  open: boolean;
  kind: "send" | "resubmit";
  onReload: () => void;
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
              Your message was sent, but this conversation has newer messages
              from another window or device. Reload to see the latest state.
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
      </div>
    </dialog>,
    document.body,
  );
}
