import { Globe, ImagePlus, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImageGenParamsEditor } from "#/components/composer/image-gen-params-editor";
import { HoverCard } from "#/components/ui/hover-card";
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
 * the image generation settings editor.
 *
 * The panel is portaled to <body> and positioned `fixed` with a high z-index
 * (same pattern as the model/reasoning switcher menus) so it never loses a
 * stacking fight against the glass sidebar or the composer dock.
 *
 * When a feature is enabled, the trigger grows into a two-segment shell
 * (plus | vertical divider | active-feature icons in accent) mirroring the
 * model & reasoning switcher join.
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
  const [menuPos, setMenuPos] = useState<{
    top: number;
    bottom: number;
    right: number;
  } | null>(null);
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

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setMenuPos(
      rect
        ? { top: rect.top, bottom: rect.bottom, right: rect.right }
        : { top: 0, bottom: 0, right: 0 },
    );
    setOpen(true);
  };

  const openFromIcon = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setMenuPos(
      rect
        ? { top: rect.top, bottom: rect.bottom, right: rect.right }
        : { top: 0, bottom: 0, right: 0 },
    );
    setOpen(true);
  };

  // Position the panel explicitly (no transform: the scale-in animation owns
  // `transform` and would otherwise override a translate). Flip above the
  // trigger when there is room, below otherwise — keeps the panel inside the
  // viewport on short windows. A ResizeObserver repositions while the panel
  // grows (model list + editor loading in) so the flip decision uses the
  // final height, not the first paint's.
  useLayoutEffect(() => {
    if (!open || !menuPos || !panelRef.current) return;
    const panel = panelRef.current;

    const applyPosition = () => {
      const height = panel.offsetHeight;
      const gap = 8;
      const openUp = menuPos.top - height - gap >= 0;
      panel.style.top = `${
        openUp ? menuPos.top - height - gap : menuPos.bottom + gap
      }px`;
      panel.style.right = `${window.innerWidth - menuPos.right}px`;
    };

    applyPosition();
    const observer = new ResizeObserver(applyPosition);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, menuPos]);

  return (
    <div className="relative inline-flex">
      <div
        className={`glass inline-flex h-8 items-stretch overflow-hidden rounded-xl transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          anyEnabled ? "" : ""
        }`}
      >
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
          onClick={toggle}
          className={`inline-flex size-8 shrink-0 cursor-pointer items-center justify-center transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/12 hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
            anyEnabled ? "rounded-l-xl text-accent" : "rounded-xl text-text-muted"
          }`}
        >
          <Plus className="size-4" strokeWidth={1.75} />
        </button>

        {anyEnabled ? (
          <>
            <span
              className="my-1.5 w-px shrink-0 self-stretch bg-white/[0.1]"
              aria-hidden
            />
            <span
              className="inline-flex items-center gap-1 rounded-r-xl px-1"
              aria-label="Active features"
            >
              {webSearchEnabled ? (
                <HoverCard
                  disabled={open}
                  variant="tooltip"
                  content={
                    webSearchAvailable
                      ? "Web search on — the agent searches the web freely"
                      : "Web search is not configured on the server"
                  }
                >
                  <button
                    type="button"
                    aria-label="Open web search settings"
                    title="Web search on"
                    onClick={openFromIcon}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  >
                    <Globe
                      className="size-4 text-accent"
                      strokeWidth={1.75}
                    />
                  </button>
                </HoverCard>
              ) : null}
              {imageGenerationEnabled ? (
                <HoverCard
                  disabled={open}
                  variant="panel"
                  content={
                    imageGenerationAvailable ? (
                      <>
                        <p className="mb-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-faint">
                          Image settings
                        </p>
                        <ImageGenParamsEditor
                          settings={settings}
                          onChange={onSettingsChange}
                          models={models.items}
                          loading={models.status === "loading"}
                          error={models.status === "error"}
                          onRetry={loadImageModels}
                        />
                      </>
                    ) : (
                      <p className="text-[11px] text-text-faint">
                        Image generation is not configured on the server
                      </p>
                    )
                  }
                >
                  <button
                    type="button"
                    aria-label="Open image generator settings"
                    title="Image generator on"
                    onClick={openFromIcon}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  >
                    <ImagePlus
                      className="size-4 text-accent"
                      strokeWidth={1.75}
                    />
                  </button>
                </HoverCard>
              ) : null}
            </span>
          </>
        ) : null}
      </div>

      {open && menuPos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Additional features"
              className="glass-popover fixed z-[80] w-[17rem] rounded-2xl p-2.5 text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-scale-in"
            >
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={webSearchEnabled}
                  aria-label="Web search"
                  title={
                    webSearchAvailable
                      ? webSearchEnabled
                        ? "Web search on — the agent searches the web freely"
                        : "Web search off — the agent asks before searching"
                      : "Web search is not configured on the server"
                  }
                  disabled={!webSearchAvailable}
                  onClick={() => onWebSearchToggle(!webSearchEnabled)}
                  className={`group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition duration-150 hover:bg-white/[0.07] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
                    !webSearchAvailable ? "opacity-40" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-text">
                    <Globe
                      className={`size-4 shrink-0 transition-colors duration-200 ${
                        webSearchEnabled
                          ? "text-accent"
                          : "text-text-muted group-hover:text-text"
                      }`}
                      strokeWidth={1.75}
                    />
                    Web search
                  </span>
                  <span
                    className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${
                      webSearchEnabled ? "bg-accent/80" : "bg-white/12"
                    }`}
                    aria-hidden
                  >
                    <span
                      className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                        webSearchEnabled
                          ? "translate-x-3.5"
                          : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>

                <button
                  type="button"
                  role="switch"
                  aria-checked={imageGenerationEnabled}
                  aria-label="Image generator"
                  title={
                    imageGenerationAvailable
                      ? imageGenerationEnabled
                        ? "Image generator on — the agent can generate images"
                        : "Image generator off — the agent asks before generating"
                      : "Image generation is not configured on the server"
                  }
                  disabled={!imageGenerationAvailable}
                  onClick={() =>
                    onImageGenerationToggle(!imageGenerationEnabled)
                  }
                  className={`group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition duration-150 hover:bg-white/[0.07] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
                    !imageGenerationAvailable ? "opacity-40" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-text">
                    <ImagePlus
                      className={`size-4 shrink-0 transition-colors duration-200 ${
                        imageGenerationEnabled
                          ? "text-accent"
                          : "text-text-muted group-hover:text-text"
                      }`}
                      strokeWidth={1.75}
                    />
                    Image generator
                  </span>
                  <span
                    className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${
                      imageGenerationEnabled
                        ? "bg-accent/80"
                        : "bg-white/12"
                    }`}
                    aria-hidden
                  >
                    <span
                      className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                        imageGenerationEnabled
                          ? "translate-x-3.5"
                          : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
