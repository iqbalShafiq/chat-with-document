import { ChevronDown, Cpu } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ModelInfo, ReasoningEffortInfo } from "#/lib/api";
import {
  formatModelContext,
  formatModelPrice,
  modalityLabel,
  modelById,
  reasoningLabel,
} from "#/lib/chat/models";
import {
  SelectOptionList,
  type SelectOption,
} from "#/components/ui/select-list";

/** Used only to order the icon fill; the actual list comes from props. */
const EFFORT_ORDER = ["low", "medium", "high", "max"];

/**
 * Hover detail for a model option: input modality tags (icons only), max
 * context window, and input/output prices.
 */
function ModelDetail({ model }: { model: ModelInfo }) {
  const priceIn = formatModelPrice(model.prices.input);
  const priceOut = formatModelPrice(model.prices.output);
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {model.inputModalities.length > 0
          ? model.inputModalities.map((modality) => (
              <span
                key={modality}
                className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-text-muted"
              >
                {modalityLabel(modality)}
              </span>
            ))
          : null}
      </div>
      <dl className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-[10px] text-text-faint">Context</dt>
          <dd className="text-[10px] font-medium text-text/90">
            {formatModelContext(model.contextWindowTokens)}
          </dd>
        </div>
        {priceIn !== null ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[10px] text-text-faint">Input</dt>
            <dd className="text-[10px] font-medium text-text/90">
              {priceIn}
            </dd>
          </div>
        ) : null}
        {priceOut !== null ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[10px] text-text-faint">Output</dt>
            <dd className="text-[10px] font-medium text-text/90">
              {priceOut}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * Single glass shell with two joined dropdowns (model | reasoning).
 * Menu is portaled so it is not clipped by composer overflow / stacking.
 */
export function ModelReasoningSwitcher({
  models,
  reasoningEfforts,
  model,
  reasoningEffort,
  disabled,
  onModelChange,
  onReasoningChange,
}: {
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
  model: string;
  reasoningEffort: string | null;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: string | null) => void;
}) {
  const [openMenu, setOpenMenu] = useState<"model" | "reasoning" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const reasoningTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const modelListId = useId();
  const reasoningListId = useId();
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);

  const selectedModel = modelById(models, model) ?? models[0] ?? null;
  const supportedEfforts = selectedModel?.reasoningEfforts ?? [];
  const selectedReasoningLabel =
    reasoningEffort === null ? "None" : reasoningLabel(reasoningEfforts, reasoningEffort);

  const updateMenuPosition = () => {
    const shell = rootRef.current;
    if (!shell) {
      setMenuPos(null);
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    // Open upward from the shared shell (composer sits at bottom of viewport).
    const minWidth = Math.max(184, shellRect.width);
    const maxLeft = window.innerWidth - minWidth - 8;
    setMenuPos({
      top: shellRect.top - 8,
      left: Math.max(8, Math.min(shellRect.left, maxLeft)),
      minWidth,
    });
  };

  useLayoutEffect(() => {
    if (!openMenu) {
      setMenuPos(null);
      return;
    }
    updateMenuPosition();
    const onReposition = () => updateMenuPosition();
    window.addEventListener("resize", onReposition);
    // Capture scroll from any ancestor (chat viewport, etc.)
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position from openMenu + refs
  }, [openMenu]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    // Defer so the opening click does not immediately close.
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (disabled) setOpenMenu(null);
  }, [disabled]);

  const toggle = (menu: "model" | "reasoning") => {
    if (disabled) return;
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  const modelOptions: SelectOption[] = models.map((m) => ({
    value: m.modelId,
    label: m.name,
    hint: m.hint ?? undefined,
    icon: (
      <ModelIcon svg={m.iconSvg} className="size-3.5 shrink-0 opacity-70" />
    ),
    detail: <ModelDetail model={m} />,
  }));

  const reasoningOptions: SelectOption[] =
    supportedEfforts.length === 0
      ? [{ value: "", label: "None", disabled: true }]
      : reasoningEfforts
          .filter((effort) => supportedEfforts.includes(effort.key))
          .map((effort) => ({
            value: effort.key,
            label: effort.label,
            icon: (
              <ReasoningEffortIcon
                effort={effort.key}
                efforts={supportedEfforts}
              />
            ),
          }));

  const menu =
    openMenu && menuPos
      ? createPortal(
          <SelectOptionList
            ref={menuRef}
            id={openMenu === "model" ? modelListId : reasoningListId}
            ariaLabel={openMenu === "model" ? "Model" : "Reasoning effort"}
            value={openMenu === "model" ? model : (reasoningEffort ?? "")}
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              minWidth: menuPos.minWidth,
              transform: "translateY(-100%)",
              zIndex: 80,
            }}
            options={openMenu === "model" ? modelOptions : reasoningOptions}
            hoverSide={openMenu === "model" ? "right" : "top"}
            onSelect={(selectedValue) => {
              if (openMenu === "model") {
                onModelChange(selectedValue);
              } else {
                onReasoningChange(selectedValue === "" ? null : selectedValue);
              }
              setOpenMenu(null);
            }}
          />,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className="relative inline-flex max-w-full">
      {/* Visual shell only — overflow clipped for rounded join, menu is portaled */}
      <div
        className={`glass inline-flex h-8 max-w-full items-stretch overflow-hidden rounded-xl text-[11px] font-medium text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          disabled ? "opacity-40" : ""
        }`}
      >
        <button
          ref={modelTriggerRef}
          type="button"
          disabled={disabled}
          aria-label="Model"
          aria-haspopup="listbox"
          aria-expanded={openMenu === "model"}
          aria-controls={modelListId}
          title={
            selectedModel
              ? `${selectedModel.name} — ${selectedModel.hint}`
              : "Model"
          }
          onClick={() => toggle("model")}
          className="inline-flex min-w-0 max-w-[7.25rem] cursor-pointer items-center gap-1.5 rounded-l-xl px-2 transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.99] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          {selectedModel ? (
            <ModelIcon
              svg={selectedModel.iconSvg}
              className="size-3.5 shrink-0"
            />
          ) : (
            <Cpu className="size-3.5 shrink-0" strokeWidth={1.75} />
          )}
          <span className="min-w-0 truncate">{selectedModel?.name}</span>
          <ChevronDown
            className={`size-3 shrink-0 opacity-60 transition-transform duration-200 ${openMenu === "model" ? "rotate-180" : ""}`}
            strokeWidth={2}
          />
        </button>

        <span
          className="my-1.5 w-px shrink-0 self-stretch bg-white/[0.1]"
          aria-hidden
        />

        <button
          ref={reasoningTriggerRef}
          type="button"
          disabled={disabled}
          aria-label="Reasoning effort"
          aria-haspopup="listbox"
          aria-expanded={openMenu === "reasoning"}
          aria-controls={reasoningListId}
          title={`Reasoning · ${selectedReasoningLabel}`}
          onClick={() => toggle("reasoning")}
          className="inline-flex min-w-0 max-w-[6.5rem] cursor-pointer items-center gap-1.5 rounded-r-xl px-2 transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.99] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          <ReasoningEffortIcon
            effort={reasoningEffort}
            efforts={supportedEfforts}
          />
          <span className="min-w-0 truncate">{selectedReasoningLabel}</span>
          <ChevronDown
            className={`size-3 shrink-0 opacity-60 transition-transform duration-200 ${openMenu === "reasoning" ? "rotate-180" : ""}`}
            strokeWidth={2}
          />
        </button>
      </div>

      {menu}
    </div>
  );
}

/**
 * Gauge icon: fill = position of the effort within the model's OWN sorted
 * effort list (e.g. DeepSeek [low, high, max] → 1/3, 2/3, 3/3), so the
 * levels are always visually distinct regardless of the model's set.
 * `null` (no reasoning) renders an empty outline with a small inner dot.
 */
export function ReasoningEffortIcon({
  effort,
  efforts,
  className = "size-3.5 shrink-0",
}: {
  effort: string | null;
  efforts: string[];
  className?: string;
}) {
  const radius = 6.25;
  const circumference = 2 * Math.PI * radius;
  const sorted = [...efforts].sort(
    (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
  );
  const index = effort === null ? -1 : sorted.indexOf(effort);
  const fill =
    effort === null || sorted.length === 0
      ? 0
      : Math.min(1, (index + 1) / sorted.length);

  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none">
      {/* Track stays muted (currentColor); the filled arc uses the primary
          accent so low → max is clearly distinguishable. */}
      <circle
        cx="8"
        cy="8"
        r={radius}
        stroke="currentColor"
        strokeWidth="1.4"
        opacity={0.9}
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        style={{ stroke: "var(--color-accent)" }}
        strokeWidth="1.4"
        strokeDasharray={`${circumference * fill} ${circumference}`}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
        opacity={0.92}
      />
      {effort === null ? (
        <circle
          cx="8"
          cy="8"
          r="2.15"
          stroke="currentColor"
          strokeWidth="1.15"
          opacity={0.45}
        />
      ) : null}
    </svg>
  );
}

/**
 * Renders a server-provided model icon (SVG string) through a minimal
 * sanitizer, falling back to the lucide `Cpu` icon when empty or invalid.
 * The wrapper is an inline-flex box so the `size-*` classes apply even when
 * nested inside another flex item, and the SVG fills the box (see
 * `.model-icon svg` in styles.css) with preserveAspectRatio centering.
 */
export function ModelIcon({
  svg,
  className,
}: {
  svg: string;
  className?: string;
}) {
  const sanitized = useMemo(() => sanitizeSvg(svg), [svg]);
  if (!sanitized) return <Cpu className={className} strokeWidth={1.75} />;
  return (
    <span
      className={`model-icon inline-flex items-center justify-center ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}

function sanitizeSvg(raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  const trimmed = raw.trim();
  if (!/^<svg[\s>]/i.test(trimmed)) return "";
  if (/<script|onload|onerror|javascript:/i.test(trimmed)) return "";
  return trimmed;
}
