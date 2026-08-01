import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { HardDrive, UserRound, X, Zap } from "lucide-react";
import {
  getUserUsageSummary,
  type UserUsageSummary,
} from "#/lib/api";
import type { SessionUser } from "#/lib/auth-client";

type SettingsSection = "account" | "usage";

export type SettingsModalProps = {
  open: boolean;
  user: SessionUser;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
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
  const titleId = useId();
  const [section, setSection] = useState<SettingsSection>("account");
  const [usage, setUsage] = useState<UserUsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

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
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 md:p-6">
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
          ) : (
            <div className="flex flex-col gap-6 animate-fade-in">
              <div>
                <h3 className="text-sm font-medium text-text">Usage</h3>
                <p className="mt-1 text-xs leading-relaxed text-text-muted">
                  Storage quota and token consumption for your account.
                </p>
              </div>

              {usageLoading ? (
                <div className="flex flex-col gap-3">
                  <div className="skeleton-shimmer h-16 w-full rounded-xl" />
                  <div className="skeleton-shimmer h-24 w-full rounded-xl" />
                </div>
              ) : usageError ? (
                <p className="text-sm text-danger" role="alert">
                  {usageError}
                </p>
              ) : usage ? (
                <>
                  <StorageUsageCard storage={usage.storage} />
                  <TokenUsageCard tokens={usage.tokens} />
                </>
              ) : null}
            </div>
          )}
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

      {/* Composition bar: input (uncached) | cache | output — relative, no max */}
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]"
        role="img"
        aria-label={`Token mix: input ${formatTokenCount(composition.inputUncached)}, cache ${formatTokenCount(composition.cacheRead)}, output ${formatTokenCount(composition.output)}`}
      >
        {compositionTotal === 0 ? (
          <div className="h-full w-full bg-white/[0.04]" />
        ) : (
          <>
            <div
              className="h-full bg-sky-400/80 transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: `${inputPct}%` }}
              title="Input"
            />
            <div
              className="h-full bg-violet-400/75 transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: `${cachePct}%` }}
              title="Cache"
            />
            <div
              className="h-full bg-accent transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: `${outputPct}%` }}
              title="Output"
            />
          </>
        )}
      </div>

      <ul className="grid gap-2 text-xs">
        <TokenLegendRow
          colorClass="bg-sky-400/80"
          label="Input"
          value={composition.inputUncached}
          hint="Uncached"
        />
        <TokenLegendRow
          colorClass="bg-violet-400/75"
          label="Cache"
          value={composition.cacheRead}
          hint="Read"
        />
        <TokenLegendRow
          colorClass="bg-accent"
          label="Output"
          value={composition.output}
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

function TokenLegendRow({
  colorClass,
  label,
  value,
  hint,
}: {
  colorClass: string;
  label: string;
  value: number;
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
        {hint ? (
          <span className="text-text-faint">· {hint}</span>
        ) : null}
      </span>
      <span className="tabular-nums text-text">{formatTokenCount(value)}</span>
    </li>
  );
}
