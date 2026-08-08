import { Check, Minus, Plus } from "lucide-react";
import { useMemo } from "react";
import { Select } from "#/components/ui/select";
import type { SelectOption } from "#/components/ui/select-list";
import type { ImageGenSettings, ImageModelCatalogItem } from "#/lib/api";

type ImageGenParamsEditorProps = {
  settings: ImageGenSettings;
  onChange: (settings: ImageGenSettings) => void;
  models: ImageModelCatalogItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
};

/**
 * Capability-driven image generation settings: model, aspect ratio pills,
 * quality, transparent background, and count. Shared by the composer
 * features popover and the approval card (Task 10).
 */
export function ImageGenParamsEditor({
  settings,
  onChange,
  models,
  loading,
  error,
  onRetry,
}: ImageGenParamsEditorProps) {
  const selectedModel = useMemo(() => {
    if (models.length === 0) return null;
    return (
      models.find((item) => item.modelId === settings.modelId) ??
      models[0] ??
      null
    );
  }, [models, settings.modelId]);

  const capabilities = selectedModel?.imageCapabilities ?? null;
  const aspectRatios = capabilities?.aspectRatios ?? ["1:1"];
  const qualityOptions: SelectOption[] =
    capabilities?.quality?.map((quality) => ({
      value: quality,
      label: quality,
    })) ?? [];
  const nMax = capabilities?.n?.max ?? 1;
  const nValue = Math.min(Math.max(settings.n ?? 1, 1), nMax);
  const transparentSupported = (capabilities?.background ?? []).includes(
    "transparent",
  );

  const modelOptions: SelectOption[] = models.map((item) => ({
    value: item.modelId,
    label: item.name,
    hint: item.hint,
  }));

  const handleModelChange = (modelId: string) => {
    const item = models.find((candidate) => candidate.modelId === modelId);
    const nextRatios = item?.imageCapabilities?.aspectRatios ?? ["1:1"];
    const nextQualities = item?.imageCapabilities?.quality ?? [];
    const ratioStillValid = nextRatios.includes(settings.aspectRatio ?? "");
    const qualityStillValid = nextQualities.includes(settings.quality ?? "");
    onChange({
      ...settings,
      modelId,
      ...(ratioStillValid ? {} : { aspectRatio: nextRatios[0] ?? "1:1" }),
      ...(qualityStillValid ? {} : { quality: undefined }),
    });
  };

  const handleAspectRatioChange = (aspectRatio: string) => {
    onChange({ ...settings, aspectRatio });
  };

  const handleQualityChange = (quality: string) => {
    onChange({ ...settings, quality });
  };

  const handleBackgroundToggle = () => {
    if (!transparentSupported) return;
    onChange({
      ...settings,
      background:
        settings.background === "transparent" ? undefined : "transparent",
    });
  };

  const handleCountChange = (delta: 1 | -1) => {
    const next = Math.min(Math.max(nValue + delta, 1), nMax);
    if (next === nValue) return;
    onChange({ ...settings, n: next });
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2.5 border-t border-white/[0.08] pt-2.5">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
          Model
        </span>
        {error ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-[11px] text-text-muted">
            <span className="min-w-0 truncate">Image models unavailable</span>
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 cursor-pointer text-[11px] font-medium text-accent transition hover:text-accent-hover"
            >
              Retry
            </button>
          </div>
        ) : (
          <Select
            value={selectedModel?.modelId ?? ""}
            onChange={handleModelChange}
            options={
              loading
                ? [{ value: "", label: "Loading…", disabled: true }]
                : modelOptions
            }
            ariaLabel="Image model"
            disabled={loading}
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
          Aspect ratio
        </span>
        <div className="flex flex-wrap gap-1.5">
          {aspectRatios.map((ratio) => {
            const selected = (settings.aspectRatio ?? "1:1") === ratio;
            return (
              <button
                key={ratio}
                type="button"
                aria-pressed={selected}
                onClick={() => handleAspectRatioChange(ratio)}
                className={`inline-flex h-6.5 min-w-11 cursor-pointer items-center justify-center rounded-lg px-2 text-[11px] font-medium transition duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
                  selected
                    ? "bg-accent text-canvas"
                    : "bg-white/[0.06] text-text-muted hover:bg-white/12 hover:text-text"
                }`}
              >
                {ratio}
              </button>
            );
          })}
        </div>
      </div>

      {qualityOptions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
            Quality
          </span>
          <Select
            value={settings.quality ?? qualityOptions[0]!.value}
            onChange={handleQualityChange}
            options={qualityOptions}
            ariaLabel="Image quality"
          />
        </div>
      ) : null}

      {transparentSupported ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={settings.background === "transparent"}
          onClick={handleBackgroundToggle}
          className="flex cursor-pointer items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          <span
            className={`inline-flex size-4 shrink-0 items-center justify-center rounded-md border transition ${
              settings.background === "transparent"
                ? "border-accent bg-accent text-canvas"
                : "border-white/[0.14] bg-white/[0.04] text-transparent"
            }`}
          >
            <Check className="size-3" strokeWidth={2.5} />
          </span>
          <span className="text-xs font-medium text-text">
            Transparent background
          </span>
        </button>
      ) : null}

      {nMax > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
            Count
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Decrease image count"
              disabled={nValue <= 1}
              onClick={() => handleCountChange(-1)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-lg bg-white/[0.06] text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Minus className="size-3.5" strokeWidth={1.75} />
            </button>
            <span
              className="min-w-5 text-center text-xs font-semibold tabular-nums text-text"
              aria-live="polite"
            >
              {nValue}
            </span>
            <button
              type="button"
              aria-label="Increase image count"
              disabled={nValue >= nMax}
              onClick={() => handleCountChange(1)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-lg bg-white/[0.06] text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
