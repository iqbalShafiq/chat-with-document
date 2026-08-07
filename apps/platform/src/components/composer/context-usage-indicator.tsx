import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextUsageInfo, ModelInfo } from "#/lib/api";
import { ModelIcon } from "#/components/composer/model-reasoning-switcher";

/** Shared session-context window height, so every model's bar uses the same ratio. */
const CONTEXT_WINDOW_CAP = 1;

/** Ring geometry: 18x18 viewBox, strokeWidth 2 → r = 8. */
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Popover width in px — used for clamping to the viewport. */
const PANEL_WIDTH = 280;

/** Transient highlight duration after compaction completes/errors. */
const FLASH_MS = 1500;

/** Compaction threshold marker position on the bars. */
const THRESHOLD_RATIO = 0.7;

export function ContextUsageIndicator({
  models,
  contextUsage,
  compaction,
  className,
}: {
  models: ModelInfo[];
  contextUsage: ContextUsageInfo | null;
  compaction: { phase: "idle" | "start" | "complete" | "error" };
  className?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [flash, setFlash] = useState<"complete" | "error" | null>(null);

  const rawRatio = contextUsage?.ratio ?? 0;
  const ratio = Math.max(0, Math.min(CONTEXT_WINDOW_CAP, rawRatio));
  const percent = Math.round(rawRatio * 100);

  useEffect(() => {
    if (compaction.phase !== "complete" && compaction.phase !== "error") return;
    setFlash(compaction.phase);
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [compaction.phase]);

  const flashColor =
    flash === "error"
      ? "text-danger"
      : flash === "complete"
        ? "text-accent"
        : null;
  const ringColor =
    flashColor ??
    (rawRatio >= 0.9
      ? "text-danger"
      : rawRatio >= THRESHOLD_RATIO
        ? "text-amber-400"
        : "text-text-muted");

  const updatePanelPosition = () => {
    const el = buttonRef.current;
    if (!el) {
      setPos(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    // Open upward, centered on the button, clamped to the viewport.
    const maxLeft = window.innerWidth - PANEL_WIDTH - 8;
    setPos({
      top: rect.top - 8,
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - PANEL_WIDTH / 2, maxLeft)),
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePanelPosition();
    const onReposition = () => updatePanelPosition();
    window.addEventListener("resize", onReposition);
    // Capture scroll from any ancestor (chat viewport, etc.)
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position from button rect + refs
  }, [open]);

  const compacting = compaction.phase === "start";
  const ringPulse = compacting || flash !== null || contextUsage === null;

  return (
    <div className={`relative ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          contextUsage === null ? "Context usage" : `Context usage: ${percent}%`
        }
        title={
          contextUsage === null
            ? "Loading context usage"
            : `Context usage: ${percent}%`
        }
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <svg
          viewBox="0 0 18 18"
          fill="none"
          aria-hidden
          className={`size-[18px] transition-colors duration-500 ${ringColor} ${
            ringPulse ? "animate-pulse" : ""
          }`}
        >
          <circle
            cx="9"
            cy="9"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeWidth="2"
            opacity={0.18}
          />
          <circle
            cx="9"
            cy="9"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - ratio)}
            transform="rotate(-90 9 9)"
            className="transition-[stroke-dashoffset] duration-500"
          />
        </svg>
      </button>

      {compacting ? (
        <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap text-[11px] font-medium text-amber-400/90 animate-pulse">
          Compacting context…
        </span>
      ) : null}

      {open && pos
        ? createPortal(
            <div
              className="glass-popover pointer-events-none fixed w-[17.5rem] rounded-xl p-3 text-text shadow-[0_12px_40px_-12px_rgb(0_0_0/0.65)] animate-fade-in"
              style={{
                top: pos.top,
                left: pos.left,
                transform: "translateY(-100%)",
                zIndex: 80,
              }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-xs font-semibold text-text">Context usage</h2>
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-text-faint">
                  <span className="h-2 w-0.5 rounded-full bg-amber-400/70" aria-hidden />
                  70% compaction threshold
                </span>
              </div>

              {compaction.phase === "error" ? (
                <p className="mt-1.5 rounded-lg bg-danger-soft px-2 py-1 text-[10px] text-danger">
                  Context compaction failed.
                </p>
              ) : null}

              <div className="my-2 h-px bg-white/[0.07]" aria-hidden />

              {models.length === 0 ? (
                <div className="flex flex-col gap-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="size-3.5 shrink-0 rounded bg-white/[0.08] skeleton-shimmer" />
                      <div className="h-2.5 w-28 rounded bg-white/[0.08] skeleton-shimmer" />
                      <div className="ml-auto h-2.5 w-10 rounded bg-white/[0.08] skeleton-shimmer" />
                    </div>
                  ))}
                </div>
              ) : contextUsage === null ? (
                <p className="text-xs text-text-muted">Usage data unavailable</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {models.map((model) => (
                    <ContextUsageRow
                      key={model.modelId}
                      model={model}
                      estimatedTokens={contextUsage.estimatedTokens}
                      ratio={ratio}
                      colorClass={ringColor}
                    />
                  ))}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function ContextUsageRow({
  model,
  estimatedTokens,
  ratio,
  colorClass,
}: {
  model: ModelInfo;
  estimatedTokens: number;
  ratio: number;
  colorClass: string;
}) {
  const { input, cachedInput, output } = model.prices;
  const priceLine =
    input !== null && output !== null
      ? `${formatUsd(input)} / ${formatUsd(cachedInput ?? input)} / ${formatUsd(
          output,
        )} per 1M`
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <ModelIcon svg={model.iconSvg} className="size-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 truncate text-xs font-medium text-text">
          {model.label}
        </span>
        <span className="shrink-0 text-[10px] text-text-faint">
          {model.provider.slug}
        </span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-text-muted">
          {Math.round(ratio * 100)}%
        </span>
      </div>

      <div
        className="relative h-1 w-full rounded-full bg-white/[0.07]"
        aria-hidden
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full bg-current transition-[width] duration-500 ${colorClass}`}
          style={{ width: `${ratio * 100}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-amber-400/70"
          style={{ left: `${THRESHOLD_RATIO * 100}%` }}
        />
      </div>

      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[10px] tabular-nums">
        <span className="truncate text-text-faint">
          {formatTokens(estimatedTokens)} / {formatTokens(model.contextWindowTokens)}
        </span>
        {priceLine ? (
          <span className="shrink-0 text-text-faint/80">{priceLine}</span>
        ) : null}
      </div>
    </div>
  );
}

/** 1050000 → "1.05M", 922000 → "922K", 12400 → "12.4K" */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
  if (abs >= 1_000) return `${trimZeros((n / 1_000).toFixed(1))}K`;
  return String(Math.round(n));
}

/** 0.2 → "$0.20", 2 → "$2.00", 30 → "$30.00", 0.123456 → "$0.1235" */
export function formatUsd(n: number): string {
  return `$${trimZerosToCents(n.toFixed(4))}`;
}

function trimZeros(value: string): string {
  return value.replace(/\.?0+$/, "");
}

function trimZerosToCents(value: string): string {
  return value.replace(/(\.\d{2})0+$/, "$1");
}
