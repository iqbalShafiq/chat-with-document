import { DialogShell } from "#/components/ui/dialog-shell";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";

export function QueueConflictDialog({
  open,
  onClose,
  onSendQueue,
  onSendNew,
}: {
  open: boolean;
  onClose: () => void;
  onSendQueue: () => void;
  onSendNew: () => void;
}) {
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Queued messages waiting"
      size="sm"
      heightMode="content"
      description="You have queued messages. Send them first, or send this message right away?"
      footer={
        <>
          <button type="button" className={DIALOG_SECONDARY_BUTTON_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={DIALOG_SECONDARY_BUTTON_CLASS} onClick={onSendNew}>
            Send new message
          </button>
          <button type="button" className={DIALOG_PRIMARY_BUTTON_CLASS} onClick={onSendQueue}>
            Send queue
          </button>
        </>
      }
    >
      <div className="px-4 py-3 text-xs leading-relaxed text-text-muted">
        The queue is paused (the previous run was stopped or failed). “Send
        queue” adds this draft to the queue and continues it. “Send new
        message” sends this draft now and keeps the queue on hold.
      </div>
    </DialogShell>
  );
}
