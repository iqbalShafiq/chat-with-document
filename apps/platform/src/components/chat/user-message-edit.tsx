import { useEffect, useId, useRef, useState } from "react";
import { PinOff, Plus } from "lucide-react";
import { useImagePreview } from "#/components/images/image-preview";
import { useGeneratedImage } from "#/components/images/use-generated-image";
import type { GeneratedImageItem } from "#/lib/chat/generated-images";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";

export type UserMessageEditProps = {
  initialText: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<void>;
  /** Context images attached to this message — shown above the textarea. */
  contextImages?: GeneratedImageItem[];
  /** Session images that can still be added as context (excludes current). */
  availableImages?: GeneratedImageItem[];
  onAddContextImage?: (image: GeneratedImageItem) => void;
  onRemoveContextImage?: (image: GeneratedImageItem) => void;
};

/**
 * Compact tile for a context image inside the edit bubble: click to view,
 * the PinOff overlay removes it from the edit's context set.
 */
function EditContextImageTile({
  image,
  onRemove,
}: {
  image: GeneratedImageItem;
  onRemove: () => void;
}) {
  const { open } = useImagePreview();
  const { displaySrc, state } = useGeneratedImage(image.id);

  if (state === "loading" || !displaySrc) {
    return (
      <div className="skeleton-shimmer aspect-square w-full rounded-lg" />
    );
  }
  if (state === "error") {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-danger/25 bg-danger-soft text-[10px] text-danger">
        Failed
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() =>
        open({ src: displaySrc, alt: image.prompt || "Context image" })
      }
      title={image.prompt || "View context image"}
      className="group relative block w-full cursor-zoom-in overflow-hidden rounded-lg border border-white/[0.08] transition hover:border-white/[0.18] active:scale-[0.98]"
    >
      <img
        src={displaySrc}
        alt={image.prompt || "Context image"}
        loading="lazy"
        className="aspect-square w-full object-cover"
      />
      <span
        role="button"
        tabIndex={0}
        aria-label="Remove image from context"
        title="Remove from context"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }
        }}
        className="absolute right-1 top-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-md bg-accent text-canvas opacity-100 transition active:scale-[0.92]"
      >
        <PinOff className="size-3" strokeWidth={2} />
      </span>
    </button>
  );
}

/** Mini tile used in the add-image picker popover. */
function PickableImageTile({
  image,
  onPick,
}: {
  image: GeneratedImageItem;
  onPick: () => void;
}) {
  const { displaySrc, state } = useGeneratedImage(image.id);
  if (state === "loading" || !displaySrc) {
    return <div className="skeleton-shimmer aspect-square w-full rounded-lg" />;
  }
  return (
    <button
      type="button"
      onClick={onPick}
      title={`Add ${image.prompt || "image"} as context`}
      className="block w-full cursor-pointer overflow-hidden rounded-lg border border-white/[0.08] transition hover:border-accent/60 active:scale-[0.97]"
    >
      <img
        src={displaySrc}
        alt={image.prompt || "Context image"}
        loading="lazy"
        className="aspect-square w-full object-cover"
      />
    </button>
  );
}

export function UserMessageEdit({
  initialText,
  busy = false,
  onCancel,
  onSubmit,
  contextImages = [],
  availableImages = [],
  onAddContextImage = () => {},
  onRemoveContextImage = () => {},
}: UserMessageEditProps) {
  const [value, setValue] = useState(initialText);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const showContextRow = contextImages.length > 0 || availableImages.length > 0;

  return (
    <div className="flex w-full flex-col gap-2">
      <label id={labelId} className="sr-only">
        Edit message
      </label>

      {showContextRow ? (
        <div className="flex flex-col gap-1.5">
          <div
            className="chat-scroll-x flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5"
            role="list"
            aria-label="Context images"
          >
            {contextImages.map((image) => (
              <div
                key={image.id}
                className="w-16 shrink-0"
                role="listitem"
              >
                <EditContextImageTile
                  image={image}
                  onRemove={() => onRemoveContextImage(image)}
                />
              </div>
            ))}
            {availableImages.length > 0 ? (
              <button
                type="button"
                aria-label="Add context image"
                title="Add context image"
                onClick={() => setPickerOpen((current) => !current)}
                className="inline-flex size-16 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-dashed border-white/[0.14] text-text-faint transition duration-150 hover:border-white/[0.28] hover:bg-white/[0.04] hover:text-text active:scale-[0.97]"
              >
                <Plus className="size-4" strokeWidth={2} />
              </button>
            ) : null}
          </div>

          {pickerOpen ? (
            <div className="chat-scroll max-h-40 overflow-y-auto rounded-xl border border-white/[0.08] bg-canvas-elevated p-1.5 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-fade-in">
              <div className="grid grid-cols-5 gap-1.5">
                {availableImages.map((image) => (
                  <PickableImageTile
                    key={image.id}
                    image={image}
                    onPick={() => {
                      onAddContextImage(image);
                      setPickerOpen(false);
                    }}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

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
