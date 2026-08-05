import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Activity,
  HardDrive,
  Sparkles,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { InsetScrollbar } from "#/components/chat/inset-scrollbar";
import { ReasoningEffortIcon } from "#/components/composer/model-reasoning-switcher";
import { PersonalizationSection } from "#/components/settings/personalization-section";
import { useProfilePersonalization } from "#/hooks/use-profile";
import {
  getUserUsageSummary,
  type UserUsageSummary,
} from "#/lib/api";
import type { SessionUser } from "#/lib/auth-client";
import {
  COMPLETION_MODELS,
  MODEL_OPTIONS,
  REASONING_EFFORTS,
  modelLabel,
  reasoningLabel,
  type ReasoningEffort,
} from "#/lib/chat/models";

type SettingsSection = "account" | "usage" | "personalization";

export type SettingsModalProps = {
  open: boolean;
  user: SessionUser;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
};

const MODEL_BAR_COLORS = [
  "bg-sky-400/80",
  "bg-violet-400/75",
  "bg-accent",
] as const;

const REASONING_BAR_COLORS: Record<ReasoningEffort, string> = {
  low: "bg-emerald-400/70",
  medium: "bg-amber-400/75",
  high: "bg-rose-400/75",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (part / total) * 100));
}

export function SettingsModal({
  open,
  user,
  onClose,
  restoreFocusRef,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [section, setSection] = useState<SettingsSection>("account");
  const [usage, setUsage] = useState<UserUsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  const profiles = useProfilePersonalization(
    open && section === "personalization",
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => closeRef.current?.focus());
      return;
    }
    if (dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      restoreFocusRef?.current?.focus();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [restoreFocusRef]);

  useEffect(() => {
    if (!open) {
      setSection("account");
      setUsage(null);
      setUsageError(null);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || section !== "usage") return;

    let cancelled = false;
    setUsageLoading(true);
    setUsageError(null);

    void (async () => {
      try {
        const data = await getUserUsageSummary();
        if (!cancelled) setUsage(data);
      } catch {
        if (!cancelled) {
          setUsageError("Could not load usage data");
          setUsage(null);
        }
      } finally {
        if (!cancelled) setUsageLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, section]);

  // Reset scroll when switching sections
  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [section]);

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog m-auto w-[min(100%-1.5rem,42rem)] rounded-2xl border border-hairline bg-canvas-elevated p-0 text-text shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)] backdrop:bg-black/55 open:flex open:flex-col animate-scale-in"
      style={{ transformOrigin: "center center" }}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      {/* Header matches app top bar height (h-14) */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
        <h2
          id={titleId}
          className="text-sm font-semibold tracking-tight text-text"
        >
          Settings
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-faint transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.08] hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          className="flex shrink-0 gap-1 border-b border-white/[0.06] p-2 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r sm:border-white/[0.06] sm:p-2.5"
          aria-label="Settings sections"
        >
          <SettingsNavButton
            active={section === "account"}
            icon={<UserRound className="size-4" strokeWidth={1.75} />}
            label="Account"
            onClick={() => setSection("account")}
          />
          <SettingsNavButton
            active={section === "usage"}
            icon={<Zap className="size-4" strokeWidth={1.75} />}
            label="Usage"
            onClick={() => setSection("usage")}
          />
          <SettingsNavButton
            active={section === "personalization"}
            icon={<Sparkles className="size-4" strokeWidth={1.75} />}
            label="Personalization"
            onClick={() => setSection("personalization")}
          />
        </nav>

        {/* Same scroll treatment as chat room: hide native bar + InsetScrollbar */}
        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={contentScrollRef}
            className="chat-scroll-bleed absolute inset-0 overflow-y-auto overscroll-contain p-5 md:p-6"
          >
            {section === "account" ? (
              <div className="flex flex-col gap-5 animate-fade-in">
                <div>
                  <h3 className="text-sm font-medium text-text">Account</h3>
                  <p className="mt-1 text-xs leading-relaxed text-text-muted">
                    Profile details for this workspace.
                  </p>
                </div>

                <dl className="grid gap-4 text-sm">
                  <div className="flex flex-col gap-1">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
                      Name
                    </dt>
                    <dd className="text-text">{user.name}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
                      Email
                    </dt>
                    <dd className="text-text">{user.email}</dd>
                  </div>
                </dl>
              </div>
            ) : section === "usage" ? (
              <div className="flex flex-col gap-6 animate-fade-in">
                <div>
                  <h3 className="text-sm font-medium text-text">Usage</h3>
                  <p className="mt-1 text-xs leading-relaxed text-text-muted">
                    Storage, tokens, and how you use models & reasoning.
                  </p>
                </div>

                {usageLoading ? (
                  <div className="flex flex-col gap-3">
                    <div className="skeleton-shimmer h-16 w-full rounded-xl" />
                    <div className="skeleton-shimmer h-24 w-full rounded-xl" />
                    <div className="skeleton-shimmer h-28 w-full rounded-xl" />
                  </div>
                ) : usageError ? (
                  <p className="text-sm text-danger" role="alert">
                    {usageError}
                  </p>
                ) : usage ? (
                  <>
                    <StorageUsageCard storage={usage.storage} />
                    <TokenUsageCard tokens={usage.tokens} />
                    <RequestMixCard
                      byModel={usage.byModel ?? []}
                      byReasoningEffort={usage.byReasoningEffort ?? []}
                      requestCount={usage.tokens.requestCount}
                    />
                  </>
                ) : null}
              </div>
            ) : (
              <PersonalizationSection
                data={profiles.data}
                loading={profiles.loading}
                error={profiles.error}
                resetting={profiles.resetting}
                onResetUser={() => void profiles.resetUser()}
                onResetProject={(id) => void profiles.resetProject(id)}
              />
            )}
          </div>
          <InsetScrollbar
            scrollRef={contentScrollRef}
            top="0.75rem"
            bottom="0.75rem"
          />
        </div>
      </div>
    </dialog>
  );
}

function SettingsNavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-9 flex-1 cursor-pointer items-center gap-2 rounded-xl px-3 text-left text-sm transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring sm:flex-none ${
        active
          ? "bg-white/[0.08] font-medium text-text"
          : "text-text-muted hover:bg-white/[0.04] hover:text-text"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function StorageUsageCard({
  storage,
}: {
  storage: UserUsageSummary["storage"];
}) {
  const usedPct = percent(storage.usedBytes, storage.maxBytes);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <HardDrive className="size-4 text-text-muted" strokeWidth={1.75} />
        <h4 className="text-sm font-medium text-text">Storage</h4>
      </div>

      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-text-muted">
          <span className="font-medium text-text">
            {formatBytes(storage.usedBytes)}
          </span>
          {" / "}
          {formatBytes(storage.maxBytes)}
        </span>
        <span className="tabular-nums text-text-faint">{usedPct.toFixed(0)}%</span>
      </div>

      <div
        className="h-2 overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-valuenow={Math.round(usedPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Storage used"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <p className="text-[11px] text-text-faint">
        {formatBytes(storage.remainingBytes)} remaining
      </p>
    </section>
  );
}

function TokenUsageCard({
  tokens,
}: {
  tokens: UserUsageSummary["tokens"];
}) {
  const { composition } = tokens;
  const compositionTotal =
    composition.inputUncached + composition.cacheRead + composition.output;

  const inputPct = percent(composition.inputUncached, compositionTotal);
  const cachePct = percent(composition.cacheRead, compositionTotal);
  const outputPct = percent(composition.output, compositionTotal);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-text-muted" strokeWidth={1.75} />
          <h4 className="text-sm font-medium text-text">Tokens</h4>
        </div>
        <span className="text-[11px] text-text-faint">No limit</span>
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-text">
          <span className="font-medium tabular-nums">
            {formatTokenCount(tokens.totalTokens)}
          </span>
          <span className="text-text-muted"> total</span>
        </p>
        <p className="text-[11px] text-text-faint">
          {tokens.requestCount} request{tokens.requestCount === 1 ? "" : "s"}
        </p>
      </div>

      <SegmentedBar
        ariaLabel={`Token mix: input ${formatTokenCount(composition.inputUncached)}, cache ${formatTokenCount(composition.cacheRead)}, output ${formatTokenCount(composition.output)}`}
        segments={
          compositionTotal === 0
            ? []
            : [
                {
                  key: "input",
                  widthPct: inputPct,
                  colorClass: "bg-sky-400/80",
                  title: "Input",
                },
                {
                  key: "cache",
                  widthPct: cachePct,
                  colorClass: "bg-violet-400/75",
                  title: "Cache",
                },
                {
                  key: "output",
                  widthPct: outputPct,
                  colorClass: "bg-accent",
                  title: "Output",
                },
              ]
        }
      />

      <ul className="grid gap-2 text-xs">
        <LegendRow
          colorClass="bg-sky-400/80"
          label="Input"
          value={formatTokenCount(composition.inputUncached)}
          hint="Uncached"
        />
        <LegendRow
          colorClass="bg-violet-400/75"
          label="Cache"
          value={formatTokenCount(composition.cacheRead)}
          hint="Read"
        />
        <LegendRow
          colorClass="bg-accent"
          label="Output"
          value={formatTokenCount(composition.output)}
        />
      </ul>

      {tokens.cacheCreationInputTokens > 0 ? (
        <p className="text-[11px] text-text-faint">
          Cache writes: {formatTokenCount(tokens.cacheCreationInputTokens)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Single Usage block for model + reasoning mix (stacked composition bars).
 */
function RequestMixCard({
  byModel,
  byReasoningEffort,
  requestCount,
}: {
  byModel: UserUsageSummary["byModel"];
  byReasoningEffort: UserUsageSummary["byReasoningEffort"];
  requestCount: number;
}) {
  // Prefer known order; include only models with activity when any data exists
  const activeModels =
    byModel.length === 0
      ? []
      : MODEL_OPTIONS.map((opt, index) => {
          const found = byModel.find((r) => r.model === opt.id);
          return {
            id: opt.id,
            label: opt.label,
            requestCount: found?.requestCount ?? 0,
            totalTokens: found?.totalTokens ?? 0,
            colorClass: MODEL_BAR_COLORS[index % MODEL_BAR_COLORS.length],
          };
        }).filter((r) => r.requestCount > 0);

  // Any unexpected models not in allow-list
  const extraModels = byModel
    .filter((r) => !(COMPLETION_MODELS as readonly string[]).includes(r.model))
    .map((r, index) => ({
      id: r.model,
      label: modelLabel(r.model),
      requestCount: r.requestCount,
      totalTokens: r.totalTokens,
      colorClass:
        MODEL_BAR_COLORS[(activeModels.length + index) % MODEL_BAR_COLORS.length],
    }));

  const modelSegments = [...activeModels, ...extraModels];
  const modelTotal = modelSegments.reduce((s, r) => s + r.requestCount, 0);

  const reasoningSegments = REASONING_EFFORTS.map((effort) => {
    const found = byReasoningEffort.find((r) => r.reasoningEffort === effort);
    return {
      id: effort,
      label: reasoningLabel(effort),
      requestCount: found?.requestCount ?? 0,
      totalTokens: found?.totalTokens ?? 0,
      colorClass: REASONING_BAR_COLORS[effort],
    };
  }).filter((r) => r.requestCount > 0);

  const reasoningTotal = reasoningSegments.reduce(
    (s, r) => s + r.requestCount,
    0,
  );

  const empty = modelSegments.length === 0 && reasoningSegments.length === 0;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-text-muted" strokeWidth={1.75} />
          <h4 className="text-sm font-medium text-text">Requests</h4>
        </div>
        <span className="text-[11px] text-text-faint">
          {requestCount} total
        </span>
      </div>

      {empty ? (
        <p className="text-xs text-text-faint">
          No chat requests yet. Model and reasoning mix will appear here.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Model mix */}
          <div className="flex flex-col gap-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
              By model
            </p>
            <SegmentedBar
              ariaLabel={`Model mix: ${modelSegments.map((s) => `${s.label} ${s.requestCount}`).join(", ")}`}
              segments={modelSegments.map((s) => ({
                key: s.id,
                widthPct: percent(s.requestCount, modelTotal),
                colorClass: s.colorClass,
                title: s.label,
              }))}
            />
            <ul className="grid gap-2 text-xs">
              {modelSegments.map((s) => (
                <LegendRow
                  key={s.id}
                  colorClass={s.colorClass}
                  label={s.label}
                  value={`${s.requestCount} req`}
                  hint={formatTokenCount(s.totalTokens)}
                />
              ))}
            </ul>
          </div>

          {/* Reasoning mix */}
          <div className="flex flex-col gap-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
              By reasoning
            </p>
            <SegmentedBar
              ariaLabel={`Reasoning mix: ${reasoningSegments.map((s) => `${s.label} ${s.requestCount}`).join(", ")}`}
              segments={reasoningSegments.map((s) => ({
                key: s.id,
                widthPct: percent(s.requestCount, reasoningTotal),
                colorClass: s.colorClass,
                title: s.label,
              }))}
            />
            <ul className="grid gap-2 text-xs">
              {reasoningSegments.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="inline-flex items-center gap-2 text-text-muted">
                    <span
                      className={`size-2 shrink-0 rounded-full ${s.colorClass}`}
                      aria-hidden
                    />
                    <ReasoningEffortIcon
                      effort={s.id as ReasoningEffort}
                      className="size-3.5 shrink-0"
                    />
                    {s.label}
                  </span>
                  <span className="inline-flex items-center gap-2 tabular-nums text-text">
                    <span>{s.requestCount} req</span>
                    <span className="text-text-faint">
                      {formatTokenCount(s.totalTokens)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function SegmentedBar({
  segments,
  ariaLabel,
}: {
  segments: Array<{
    key: string;
    widthPct: number;
    colorClass: string;
    title: string;
  }>;
  ariaLabel: string;
}) {
  return (
    <div
      className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]"
      role="img"
      aria-label={ariaLabel}
    >
      {segments.length === 0 ? (
        <div className="h-full w-full bg-white/[0.04]" />
      ) : (
        segments.map((seg) =>
          seg.widthPct <= 0 ? null : (
            <div
              key={seg.key}
              className={`h-full transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${seg.colorClass}`}
              style={{ width: `${seg.widthPct}%` }}
              title={seg.title}
            />
          ),
        )
      )}
    </div>
  );
}

function LegendRow({
  colorClass,
  label,
  value,
  hint,
}: {
  colorClass: string;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2 text-text-muted">
        <span
          className={`size-2 shrink-0 rounded-full ${colorClass}`}
          aria-hidden
        />
        {label}
        {hint ? <span className="text-text-faint">· {hint}</span> : null}
      </span>
      <span className="tabular-nums text-text">{value}</span>
    </li>
  );
}
