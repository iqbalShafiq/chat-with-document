import { ImagePlus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ImageGenParamsEditor } from "#/components/composer/image-gen-params-editor";
import { WebSearchToggle } from "#/components/composer/web-search-toggle";
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
 * the image generation settings editor. Positioning matches PopoverMenu
 * (opens above-right of the anchored button).
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

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Additional features"
        title={
          anyAvailable
            ? "Additional features"
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
            <ImageGenParamsEditor
              settings={settings}
              onChange={onSettingsChange}
              models={models.items}
              loading={models.status === "loading"}
              error={models.status === "error"}
              onRetry={loadImageModels}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
