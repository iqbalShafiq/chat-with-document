import { ChevronDown, Cpu } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  type CompletionModelId,
  type ReasoningEffort,
} from "#/lib/chat/models";
import {
  SelectOptionList,
  type SelectOption,
} from "#/components/ui/select-list";

/**
 * Single glass shell with two joined dropdowns (model | reasoning).
 * Menu is portaled so it is not clipped by composer overflow / stacking.
 */
export function ModelReasoningSwitcher({
  model,
  reasoningEffort,
  disabled,
  onModelChange,
  onReasoningChange,
}: {
  model: CompletionModelId;
  reasoningEffort: ReasoningEffort;
  disabled?: boolean;
  onModelChange: (model: CompletionModelId) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
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

  const selectedModel =
    MODEL_OPTIONS.find((o) => o.id === model) ?? MODEL_OPTIONS[0];
  const selectedReasoning =
    REASONING_OPTIONS.find((o) => o.id === reasoningEffort) ??
    REASONING_OPTIONS[1];

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

  const modelOptions: SelectOption[] = MODEL_OPTIONS.map((opt) => ({
    value: opt.id,
    label: opt.label,
    hint: opt.hint,
    icon: (
      <Cpu
        className="size-3.5 shrink-0 opacity-70"
        strokeWidth={1.75}
      />
    ),
  }));

  const reasoningOptions: SelectOption[] = REASONING_OPTIONS.map((opt) => ({
    value: opt.id,
    label: opt.label,
    icon: <ReasoningEffortIcon effort={opt.id} />,
  }));

  const menu =
    openMenu && menuPos
      ? createPortal(
          <SelectOptionList
            ref={menuRef}
            id={openMenu === "model" ? modelListId : reasoningListId}
            ariaLabel={openMenu === "model" ? "Model" : "Reasoning effort"}
            value={openMenu === "model" ? model : reasoningEffort}
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              minWidth: menuPos.minWidth,
              transform: "translateY(-100%)",
              zIndex: 80,
            }}
            options={openMenu === "model" ? modelOptions : reasoningOptions}
            onSelect={(selectedValue) => {
              if (openMenu === "model") {
                onModelChange(selectedValue as CompletionModelId);
              } else {
                onReasoningChange(selectedValue as ReasoningEffort);
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
              ? `${selectedModel.label} — ${selectedModel.hint}`
              : "Model"
          }
          onClick={() => toggle("model")}
          className="inline-flex min-w-0 max-w-[7.25rem] cursor-pointer items-center gap-1.5 rounded-l-xl px-2 transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.99] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          <Cpu className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{selectedModel?.label}</span>
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
          title={`Reasoning · ${selectedReasoning?.label ?? reasoningEffort}`}
          onClick={() => toggle("reasoning")}
          className="inline-flex min-w-0 max-w-[6.5rem] cursor-pointer items-center gap-1.5 rounded-r-xl px-2 transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.99] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          <ReasoningEffortIcon effort={reasoningEffort} />
          <span className="min-w-0 truncate">{selectedReasoning?.label}</span>
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
 * Gauge icon: low = outline, medium = half filled, high = solid fill.
 */
export function ReasoningEffortIcon({
  effort,
  className = "size-3.5 shrink-0",
}: {
  effort: ReasoningEffort;
  className?: string;
}) {
  const fill =
    effort === "high" ? "full" : effort === "medium" ? "half" : "none";

  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      aria-hidden
      fill="none"
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity={0.9}
      />
      {fill === "full" ? (
        <circle cx="8" cy="8" r="4.1" fill="currentColor" opacity={0.92} />
      ) : null}
      {fill === "half" ? (
        <path
          d="M8 3.9a4.1 4.1 0 0 0 0 8.2V3.9Z"
          fill="currentColor"
          opacity={0.92}
        />
      ) : null}
      {fill === "none" ? (
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
