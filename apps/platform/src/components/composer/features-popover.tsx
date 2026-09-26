import { Brain, Globe, ImagePlus, Plug, Plus, Search, Settings2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ImageGenParamsEditor } from "#/components/composer/image-gen-params-editor";
import { CountBadge } from "#/components/ui/count-badge";
import { Switch } from "#/components/ui/switch";
import { HoverCard } from "#/components/ui/hover-card";
import {
  fetchImageModels,
  type ImageGenSettings,
  type ImageModelCatalogItem,
} from "#/lib/api";

export type FeatureCountSummary = {
  active: number;
  total: number;
};

type FeaturesPopoverProps = {
  webSearchEnabled: boolean;
  onWebSearchToggle: (enabled: boolean) => void;
  webSearchAvailable: boolean;
  deepResearchEnabled: boolean;
  onDeepResearchToggle: (enabled: boolean) => void;
  deepResearchAvailable: boolean;
  imageGenerationEnabled: boolean;
  onImageGenerationToggle: (enabled: boolean) => void;
  imageGenerationAvailable: boolean;
  settings: ImageGenSettings;
  onSettingsChange: (settings: ImageGenSettings) => void;
  /** Null while the catalog is still loading. */
  skillsSummary?: FeatureCountSummary | null;
  mcpSummary?: FeatureCountSummary | null;
  skillsPerChatEnabled?: boolean;
  mcpPerChatEnabled?: boolean;
  onSkillsToggle?: (enabled: boolean) => void;
  onMcpToggle?: (enabled: boolean) => void;
  onOpenSkills?: () => void;
  onOpenMcp?: () => void;
};

type ImageModelsState =
  | { status: "loading"; items: [] }
  | { status: "error"; items: [] }
  | { status: "success"; items: ImageModelCatalogItem[] };

/**
 * Switch row with a count badge and a manage entry point. The switch flips
 * per-chat state; the gear opens the full management modal.
 */
function EnhancementRow({
  icon,
  label,
  activeLabel,
  inactiveLabel,
  enabled,
  onToggle,
  toggleDisabled,
  badge,
  onOpen,
  openLabel,
}: {
  icon: ReactNode;
  label: string;
  activeLabel: string;
  inactiveLabel: string;
  enabled: boolean;
  onToggle: () => void;
  toggleDisabled: boolean;
  badge: ReactNode;
  onOpen: () => void;
  openLabel: string;
}) {
  return (
    <div className="group flex w-full items-center gap-1 rounded-lg transition duration-150 hover:bg-white/[0.07] focus-within:bg-white/[0.07]">
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2 py-2">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-text">
          {icon}
          {label}
          {badge}
        </span>
        <Switch
          checked={enabled}
          onToggle={onToggle}
          label={label}
          title={enabled ? activeLabel : inactiveLabel}
          disabled={toggleDisabled}
        />
      </div>
      <button
        type="button"
        aria-label={openLabel}
        title={openLabel}
        onClick={onOpen}
        className="mr-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <Settings2 className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

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
  deepResearchEnabled,
  onDeepResearchToggle,
  deepResearchAvailable,
  imageGenerationEnabled,
  onImageGenerationToggle,
  imageGenerationAvailable,
  settings,
  onSettingsChange,
  skillsSummary = null,
  mcpSummary = null,
  skillsPerChatEnabled = false,
  mcpPerChatEnabled = false,
  onSkillsToggle = () => {},
  onMcpToggle = () => {},
  onOpenSkills = () => {},
  onOpenMcp = () => {},
}: FeaturesPopoverProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    bottom: number;
    left: number;
    right: number;
  } | null>(null);
  const [models, setModels] = useState<ImageModelsState>({
    status: "loading",
    items: [],
  });

  const anyAvailable =
    webSearchAvailable ||
    deepResearchAvailable ||
    imageGenerationAvailable ||
    skillsSummary !== null ||
    mcpSummary !== null;
  const anyEnabled =
    webSearchEnabled ||
    deepResearchEnabled ||
    imageGenerationEnabled ||
    skillsPerChatEnabled ||
    mcpPerChatEnabled;

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
        ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
        : { top: 0, bottom: 0, left: 0, right: 0 },
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
        ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
        : { top: 0, bottom: 0, left: 0, right: 0 },
    );
    setOpen(true);
  };

  // Position the panel explicitly (no transform: the scale-in animation owns
  // `transform` and would otherwise override a translate). Flip above the
  // trigger when there is room, below otherwise — keeps the panel inside the
  // viewport on short windows. Horizontally the panel hugs the trigger's
  // right edge, unless that would push it past the left edge — then it
  // docks to the left viewport margin instead. A ResizeObserver repositions
  // while the panel grows (model list + editor loading in) so the flip
  // decisions use the final size, not the first paint's; window resizes
  // re-run the same clamp.
  useLayoutEffect(() => {
    if (!open || !menuPos || !panelRef.current) return;
    const panel = panelRef.current;

    const applyPosition = () => {
      const height = panel.offsetHeight;
      const width = panel.offsetWidth;
      const gap = 8;
      const margin = 8;
      const openUp = menuPos.top - height - gap >= 0;
      panel.style.top = `${
        openUp ? menuPos.top - height - gap : menuPos.bottom + gap
      }px`;
      if (menuPos.right - width < margin) {
        panel.style.left = `${margin}px`;
        panel.style.right = "auto";
      } else {
        panel.style.right = `${window.innerWidth - menuPos.right}px`;
        panel.style.left = "auto";
      }
    };

    applyPosition();
    const observer = new ResizeObserver(applyPosition);
    observer.observe(panel);
    window.addEventListener("resize", applyPosition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", applyPosition);
    };
  }, [open, menuPos]);

  return (
    <div className="relative inline-flex">
      {anyEnabled ? (
      <div
        className="glass inline-flex h-9 items-stretch overflow-hidden rounded-xl px-1 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
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
          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center self-center rounded-lg text-accent transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/12 hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          <Plus className="size-4" strokeWidth={1.75} />
        </button>

          <>
            <span
              className="mx-1 my-1.5 w-px shrink-0 self-stretch bg-white/[0.1]"
              aria-hidden
            />
            <span
              className="inline-flex items-center gap-1 rounded-r-xl"
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
              {deepResearchEnabled ? (
                <HoverCard
                  disabled={open}
                  variant="panel"
                  content={
                    <p className="text-[11px] text-text-faint">
                      Deep Research is on — the agent can synthesize active documents and web evidence
                    </p>
                  }
                >
                  <button
                    type="button"
                    aria-label="Deep Research on"
                    title="Deep Research on"
                    onClick={openFromIcon}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  >
                    <Search className="size-4 text-accent" strokeWidth={1.75} />
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
              {skillsPerChatEnabled ? (
                <HoverCard
                  disabled={open}
                  variant="tooltip"
                  content={
                    skillsSummary
                      ? `${skillsSummary.active} of ${skillsSummary.total} skills active for this chat`
                      : "Skills on for this chat"
                  }
                >
                  <button
                    type="button"
                    aria-label="Open skills settings"
                    title="Skills on"
                    onClick={openFromIcon}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  >
                    <Brain
                      className="size-4 text-accent"
                      strokeWidth={1.75}
                    />
                  </button>
                </HoverCard>
              ) : null}
              {mcpPerChatEnabled ? (
                <HoverCard
                  disabled={open}
                  variant="tooltip"
                  content={
                    mcpSummary
                      ? `${mcpSummary.active} of ${mcpSummary.total} MCP servers active for this chat`
                      : "MCP on for this chat"
                  }
                >
                  <button
                    type="button"
                    aria-label="Open MCP settings"
                    title="MCP on"
                    onClick={openFromIcon}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  >
                    <Plug
                      className="size-4 text-accent"
                      strokeWidth={1.75}
                    />
                  </button>
                </HoverCard>
              ) : null}
            </span>
          </>
      </div>
      ) : (
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
          className="glass glass-interactive inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          <Plus className="size-4" strokeWidth={1.75} />
        </button>
      )}

      {open && menuPos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Additional features"
              className="glass-popover fixed z-[80] w-[17rem] max-w-[calc(100vw-16px)] rounded-2xl p-2.5 text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-scale-in"
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
                      className={`absolute left-0 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
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
                  aria-checked={deepResearchEnabled}
                  aria-label="Deep Research"
                  title={
                    deepResearchAvailable
                      ? deepResearchEnabled
                        ? "Deep Research on — the agent can run a bounded multi-source investigation"
                        : "Deep Research off — the agent asks before starting research"
                      : "Deep Research needs web search or an active document"
                  }
                  disabled={!deepResearchAvailable}
                  onClick={() => onDeepResearchToggle(!deepResearchEnabled)}
                  className={`group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition duration-150 hover:bg-white/[0.07] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
                    !deepResearchAvailable ? "opacity-40" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-text">
                    <Search
                      className={`size-4 shrink-0 transition-colors duration-200 ${
                        deepResearchEnabled
                          ? "text-accent"
                          : "text-text-muted group-hover:text-text"
                      }`}
                      strokeWidth={1.75}
                    />
                    Deep Research
                  </span>
                  <span
                    className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${
                      deepResearchEnabled ? "bg-accent/80" : "bg-white/12"
                    }`}
                    aria-hidden
                  >
                    <span
                      className={`absolute left-0 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                        deepResearchEnabled
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
                      className={`absolute left-0 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                        imageGenerationEnabled
                          ? "translate-x-3.5"
                          : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>

                {skillsSummary !== null ? (
                  <EnhancementRow
                    icon={
                      <Brain
                        className={`size-4 shrink-0 transition-colors duration-200 ${
                          skillsPerChatEnabled
                            ? "text-accent"
                            : "text-text-muted group-hover:text-text"
                        }`}
                        strokeWidth={1.75}
                      />
                    }
                    label="Skills"
                    activeLabel="Skills on — the agent follows your enabled skills"
                    inactiveLabel={
                      skillsSummary.total === 0
                        ? "No skills yet — open Skills to write the first one"
                        : "Skills off for this chat"
                    }
                    enabled={skillsPerChatEnabled}
                    onToggle={() => onSkillsToggle(!skillsPerChatEnabled)}
                    toggleDisabled={skillsSummary.total === 0}
                    badge={
                      <CountBadge
                        count={skillsSummary.active}
                        label="skills active"
                        tone={skillsPerChatEnabled ? "accent" : "neutral"}
                      />
                    }
                    onOpen={onOpenSkills}
                    openLabel="Manage skills"
                  />
                ) : null}

                {mcpSummary !== null ? (
                  <EnhancementRow
                    icon={
                      <Plug
                        className={`size-4 shrink-0 transition-colors duration-200 ${
                          mcpPerChatEnabled
                            ? "text-accent"
                            : "text-text-muted group-hover:text-text"
                        }`}
                        strokeWidth={1.75}
                      />
                    }
                    label="MCP"
                    activeLabel="MCP on — the agent can use your connected servers"
                    inactiveLabel={
                      mcpSummary.total === 0
                        ? "No servers yet — open MCP to connect the first one"
                        : "MCP off for this chat"
                    }
                    enabled={mcpPerChatEnabled}
                    onToggle={() => onMcpToggle(!mcpPerChatEnabled)}
                    toggleDisabled={mcpSummary.total === 0}
                    badge={
                      <CountBadge
                        count={mcpSummary.active}
                        label="MCP servers active"
                        tone={mcpPerChatEnabled ? "accent" : "neutral"}
                      />
                    }
                    onOpen={onOpenMcp}
                    openLabel="Manage MCP servers"
                  />
                ) : null}
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
