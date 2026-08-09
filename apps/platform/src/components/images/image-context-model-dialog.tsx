import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DIALOG_PRIMARY_BUTTON_CLASS, DIALOG_SECONDARY_BUTTON_CLASS } from "#/components/ui/dialog-actions";
import { Select } from "#/components/ui/select";
import type { SelectOption } from "#/components/ui/select-list";
import { ModelIcon } from "#/components/composer/model-reasoning-switcher";
import type { ModelInfo, ReasoningEffortInfo } from "#/lib/api";

/**
 * Confirmation dialog shown when the user tries to pin an image as chat
 * context while the currently selected model cannot accept image input.
 * The user must pick a vision-capable model (and optionally a reasoning
 * effort) before confirming; the confirm button stays disabled until then.
 */
export function ImageContextModelDialog({
  open,
  models,
  reasoningEfforts,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
  busy?: boolean;
  error?: string | null;
  onConfirm: (input: { modelId: string; reasoningEffort: string | null }) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const visionModels = useMemo(
    () =>
      models.filter((model) => model.inputModalities.includes("image")),
    [models],
  );
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setModelId("");
      setReasoningEffort("");
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      }
    } else {
      dialogRef.current?.close();
    }
  }, [open]);

  const selectedModel = visionModels.find((model) => model.modelId === modelId);
  const supportedEfforts = useMemo(() => {
    if (!selectedModel) return [];
    return reasoningEfforts.filter((effort) =>
      selectedModel.reasoningEfforts.includes(effort.key),
    );
  }, [selectedModel, reasoningEfforts]);

  const modelOptions: SelectOption[] = visionModels.map((model) => ({
    value: model.modelId,
    label: model.name,
    hint: model.hint ?? undefined,
    icon: (
      <ModelIcon svg={model.iconSvg} className="size-3.5 shrink-0 opacity-70" />
    ),
  }));

  const effortOptions: SelectOption[] = supportedEfforts.map((effort) => ({
    value: effort.key,
    label: effort.label,
  }));
  const showEffort = supportedEfforts.length > 0;
  const canConfirm =
    modelId.length > 0 && (!showEffort || reasoningEffort !== "");

  if (!open) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="image-context-dialog-title"
      aria-describedby="image-context-dialog-desc"
      className="m-auto w-[min(100%-1.5rem,26rem)] overflow-visible rounded-2xl border border-hairline bg-canvas-elevated p-0 text-text shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)] backdrop:bg-black/55 open:flex animate-scale-in"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      {/* Scroll wrapper: the dialog box itself must NOT clip/scroll so the
          portaled Select dropdown can float above the modal content. */}
      <div
        className="chat-scroll flex max-h-[85dvh] w-full flex-col gap-3 overflow-y-auto p-5"
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) onCancel();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2
            id="image-context-dialog-title"
            className="text-sm font-semibold tracking-tight"
          >
            Add image as chat context
          </h2>
          <p
            id="image-context-dialog-desc"
            className="text-xs leading-relaxed text-text-muted"
          >
            The current model cannot accept image input. Choose a vision-capable
            model to send this image to the chat as context.
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-text-faint">Model</span>
          <Select
            value={modelId}
            onChange={setModelId}
            options={modelOptions}
            ariaLabel="Vision model"
            disabled={busy}
            hoverSide="right"
          />
        </label>

        {showEffort ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-text-faint">
              Reasoning effort
            </span>
            <Select
              value={reasoningEffort}
              onChange={setReasoningEffort}
              options={effortOptions}
              ariaLabel="Reasoning effort"
              disabled={busy}
            />
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={DIALOG_SECONDARY_BUTTON_CLASS}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !canConfirm}
            onClick={() =>
              onConfirm({
                modelId,
                reasoningEffort: reasoningEffort === "" ? null : reasoningEffort,
              })
            }
            className={DIALOG_PRIMARY_BUTTON_CLASS}
          >
            {busy ? "Switching…" : "Switch model & add context"}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
