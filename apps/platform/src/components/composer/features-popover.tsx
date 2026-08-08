import { Check, ImagePlus, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { WebSearchToggle } from "#/components/composer/web-search-toggle";
import { Select } from "#/components/ui/select";
import type { SelectOption } from "#/components/ui/select-list";
import {
  fetchImageModels,
  type ImageGenSettings,
  type ImageModelCatalogItem,
} from "#/lib/api";

type FeaturesPopoverProps = {
  webSearchEnabled: boolean;
  onWebSearchToggle: (enabled: boolean) => void;
  webSearchAvailable: boolean;
  imageGenerationEnabled: boolean;
  onImageGenerationToggle: (enabled: boolean) => void;
  imageGenerationAvailable: boolean;
  settings: ImageGenSettings;
  onSettingsChange: (settings: ImageGenSettings) => void;
};

type ImageModelsState =
  | { status: "loading"; items: [] }
  | { status: "error"; items: [] }
  | { status: "success"; items: ImageModelCatalogItem[] };

/**
 * Plus-button popover hosting the web search + image generator toggles and
 * capability-driven image generation settings. Positioning matches
 * PopoverMenu (opens above-right of the anchored button).
 */
export function FeaturesPopover({
  webSearchEnabled,
  onWebSearchToggle,
  webSearchAvailable,
  imageGenerationEnabled,
  onImageGenerationToggle,
  imageGenerationAvailable,
  settings,
  onSettingsChange,
}: FeaturesPopoverProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ImageModelsState>({
    status: "loading",
    items: [],
  });

  const anyAvailable = webSearchAvailable || imageGenerationAvailable;
  const anyEnabled = webSearchEnabled || imageGenerationEnabled;

  const loadImageModels = () => {
    setModels({ status: "loading", items: [] });
    void fetchImageModels()
      .then((items) => setModels({ status: "success", items }))
      .catch(() => setModels({ status: "error", items: [] }));
  };

  useEffect(() => {
    if (!open) return;
    if (models.status === "success" || models.status === "error") return;
    loadImageModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- models refetched on retry only
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointer = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointer, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const selectedModel = useMemo(() => {
    const items = models.items;
    if (items.length === 0) return null;
    return (
      items.find((item) => item.modelId === settings.modelId) ?? items[0] ?? null
    );
  }, [models.items, settings.modelId]);

  const capabilities = selectedModel?.imageCapabilities ?? null;
  const aspectRatios = capabilities?.aspectRatios ?? ["1:1"];
  const qualityOptions: SelectOption[] =
    capabilities?.quality?.map((quality) => ({
      value: quality,
      label: quality,
    })) ?? [];
  const nMax = capabilities?.n?.max ?? 1;
  const nValue = Math.min(Math.max(settings.n ?? 1, 1), nMax);
  const transparentSupported =
    (capabilities?.background ?? []).includes("transparent") ?? false;

  const modelOptions: SelectOption[] = models.items.map((item) => ({
    value: item.modelId,
    label: item.name,
    hint: item.hint,
  }));

  const handleModelChange = (modelId: string) => {
    const item = models.items.find((candidate) => candidate.modelId === modelId);
    const nextRatios = item?.imageCapabilities?.aspectRatios ?? ["1:1"];
    const nextQualities = item?.imageCapabilities?.quality ?? [];
    const ratioStillValid = nextRatios.includes(settings.aspectRatio ?? "");
    const qualityStillValid = nextQualities.includes(settings.quality ?? "");
    onSettingsChange({
      ...settings,
      modelId,
      ...(ratioStillValid ? {} : { aspectRatio: nextRatios[0] ?? "1:1" }),
      ...(qualityStillValid ? {} : { quality: undefined }),
    });
  };

  const handleAspectRatioChange = (aspectRatio: string) => {
    onSettingsChange({ ...settings, aspectRatio });
  };

  const handleQualityChange = (quality: string) => {
    onSettingsChange({ ...settings, quality });
  };

  const handleBackgroundToggle = () => {
    if (!transparentSupported) return;
    onSettingsChange({
      ...settings,
      background: settings.background === "transparent" ? undefined : "transparent",
    });
  };

  const handleCountChange = (delta: 1 | -1) => {
    const next = Math.min(Math.max(nValue + delta, 1), nMax);
    if (next === nValue) return;
    onSettingsChange({ ...settings, n: next });
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Additional features"
        title={
          anyAvailable
            ? anyEnabled
              ? "Additional features"
              : "Additional features"
            : "No additional features available on this server"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!anyAvailable}
        onClick={() => setOpen((current) => !current)}
        className={`glass glass-interactive inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 ${
          anyEnabled ? "text-accent" : "text-text-muted"
        }`}
      >
        <Plus className="size-4" strokeWidth={1.75} />
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Additional features"
          className="glass-popover absolute bottom-full right-0 z-30 mb-1.5 w-[17rem] rounded-xl p-3 text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-fade-in"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-text">
                Web search
              </span>
              <WebSearchToggle
                enabled={webSearchEnabled}
                available={webSearchAvailable}
                onToggle={onWebSearchToggle}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-text">
                Image generator
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={imageGenerationEnabled}
                aria-label="Image generator"
                title={
                  imageGenerationAvailable
                    ? "Generate images with the agent"
                    : "Image generation is not configured on the server"
                }
                disabled={!imageGenerationAvailable}
                onClick={() => onImageGenerationToggle(!imageGenerationEnabled)}
                className={`glass inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-xl px-2 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/12 active:scale-[0.98] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
                  !imageGenerationAvailable ? "opacity-40" : ""
                }`}
              >
                <ImagePlus
                  className={`size-4 transition-colors duration-200 ${
                    imageGenerationEnabled ? "text-accent" : "text-text-muted"
                  }`}
                  strokeWidth={1.75}
                />
              </button>
            </div>
          </div>

          {imageGenerationEnabled ? (
            <div className="mt-2.5 flex flex-col gap-2.5 border-t border-white/[0.08] pt-2.5">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
                  Model
                </span>
                {models.status === "error" ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-[11px] text-text-muted">
                    <span className="min-w-0 truncate">Image models unavailable</span>
                    <button
                      type="button"
                      onClick={loadImageModels}
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
                      models.status === "loading"
                        ? [{ value: "", label: "Loading…", disabled: true }]
                        : modelOptions
                    }
                    ariaLabel="Image model"
                    disabled={models.status !== "success"}
                  />
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-text-faint">
                  Aspect ratio
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {aspectRatios.map((ratio) => {
                    const selected =
                      (settings.aspectRatio ?? "1:1") === ratio;
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
                  className="flex cursor-pointer items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring rounded-md"
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
