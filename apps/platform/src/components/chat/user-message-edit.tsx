import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";

export type UserMessageEditProps = {
  initialText: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<void>;
};

export function UserMessageEdit({
  initialText,
  busy = false,
  onCancel,
  onSubmit,
}: UserMessageEditProps) {
  const [value, setValue] = useState(initialText);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !busy && !confirmBusy;

  return (
    <div className="flex w-full flex-col gap-2">
      <label id={labelId} className="sr-only">
        Edit message
      </label>
      <textarea
        ref={textareaRef}
        aria-labelledby={labelId}
        value={value}
        disabled={busy || confirmBusy}
        onChange={(event) => {
          setValue(event.target.value);
          const el = event.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (!confirmBusy) onCancel();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (canSubmit) setConfirmOpen(true);
          }
        }}
        rows={2}
        className="chat-scroll min-h-[3rem] max-h-60 w-full resize-none overflow-y-auto rounded-xl border border-hairline bg-white/[0.04] px-3 py-2 text-sm leading-relaxed text-text outline-none ring-accent-ring focus:ring-2 disabled:opacity-60"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="inline-flex min-h-8 cursor-pointer items-center rounded-lg px-2.5 text-xs font-medium text-text-muted transition hover:bg-white/8 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onCancel}
          disabled={busy || confirmBusy}
        >
          Cancel
        </button>
        <button
          ref={submitRef}
          type="button"
          className="inline-flex min-h-8 cursor-pointer items-center rounded-lg bg-accent px-2.5 text-xs font-medium text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canSubmit}
          onClick={() => {
            setConfirmError(null);
            setConfirmOpen(true);
          }}
        >
          Save &amp; resubmit
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Replace this message?"
        description="Your edited message will replace this one. All later messages will be removed, and the assistant will reply again."
        confirmLabel="Save & resubmit"
        cancelLabel="Cancel"
        busy={confirmBusy}
        error={confirmError}
        restoreFocusRef={submitRef}
        onCancel={() => {
          if (confirmBusy) return;
          setConfirmOpen(false);
          setConfirmError(null);
        }}
        onConfirm={() => {
          if (confirmBusy || !trimmed) return;
          setConfirmBusy(true);
          setConfirmError(null);
          void (async () => {
            try {
              await onSubmit(trimmed);
              setConfirmOpen(false);
            } catch (error) {
              setConfirmError(
                error instanceof Error
                  ? error.message
                  : "Could not save the edited message",
              );
            } finally {
              setConfirmBusy(false);
            }
          })();
        }}
      />
    </div>
  );
}
