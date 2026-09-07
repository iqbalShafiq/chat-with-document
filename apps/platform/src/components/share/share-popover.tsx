import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Link2, Loader2, Share2 } from "lucide-react";
import { copyToClipboard } from "#/lib/clipboard";
import {
  ApiAuthError,
  createShareLink,
  deactivateShareLinks,
  fetchLatestShareLink,
  shareUrl,
} from "#/lib/api";
import { AutoDismissPopover } from "#/components/ui/auto-dismiss-popover";
import {
  BUTTON_BASE_CLASS,
  BUTTON_SIZE_CLASSES,
  BUTTON_VARIANT_CLASSES,
} from "#/components/ui/button";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";
import { DialogShell } from "#/components/ui/dialog-shell";
import { isShareLinkStale } from "#/lib/session-history";

const DIALOG_DANGER_BUTTON_CLASS = [
  BUTTON_BASE_CLASS,
  BUTTON_VARIANT_CLASSES.danger,
  BUTTON_SIZE_CLASSES.md,
].join(" ");

type ShareLinkState =
  | { kind: "loading" }
  | { kind: "ready"; link: { token: string; createdAt: string } | null }
  | { kind: "error"; message: string };

/**
 * Share dialog: the active link lives inline in the status row (single line,
 * truncated), with a trailing copy action. Generating snapshots the current
 * history; sending a new message afterwards makes the link stale, so the row
 * keeps a short "activated" status and the copy action regenerates instead.
 */
export function SharePopover({
  sessionId,
  sessionTitle,
  sessionUpdatedAt,
  open,
  onClose,
  onStatusChange,
  onGenerated,
  onAuthFailure,
}: {
  sessionId: string;
  sessionTitle: string;
  /** ISO timestamp of the chat's latest activity (stale-link detection). */
  sessionUpdatedAt?: string | null;
  open: boolean;
  onClose: () => void;
  onStatusChange?: (sessionId: string, active: boolean) => void;
  /** Fired with the fresh token so the shell can refresh its copy target. */
  onGenerated?: (sessionId: string) => void;
  onAuthFailure?: () => void;
}) {
  const [state, setState] = useState<ShareLinkState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<"copied" | "generated" | null>(
    null,
  );
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const latest = await fetchLatestShareLink(sessionId);
      setState({
        kind: "ready",
        link: latest
          ? { token: latest.token, createdAt: latest.createdAt }
          : null,
      });
      onStatusChange?.(sessionId, latest !== null);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        onAuthFailure?.();
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not load sharing",
      });
    }
  }, [onAuthFailure, onStatusChange, sessionId]);

  useEffect(() => {
    if (open) {
      setFeedback(null);
      void load();
    } else {
      setState({ kind: "loading" });
    }
  }, [load, open]);

  const handleGenerate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await createShareLink(sessionId);
      setState({
        kind: "ready",
        link: { token: created.token, createdAt: created.createdAt },
      });
      onStatusChange?.(sessionId, true);
      onGenerated?.(sessionId);
      const ok = await copyToClipboard(
        `${window.location.origin}${shareUrl(created.token)}`,
      );
      if (ok) setFeedback("generated");
    } catch (error) {
      if (error instanceof ApiAuthError) {
        onAuthFailure?.();
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not create link",
      });
    } finally {
      setBusy(false);
    }
  }, [busy, onAuthFailure, onGenerated, onStatusChange, sessionId]);

  const handleCopyLink = useCallback(async (token: string) => {
    const ok = await copyToClipboard(
      `${window.location.origin}${shareUrl(token)}`,
    );
    if (ok) setFeedback("copied");
  }, []);

  const handleDeactivate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deactivateShareLinks(sessionId);
      setState({ kind: "ready", link: null });
      onStatusChange?.(sessionId, false);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        onAuthFailure?.();
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not deactivate",
      });
    } finally {
      setBusy(false);
    }
  }, [busy, onAuthFailure, onStatusChange, sessionId]);

  const activeLink =
    state.kind === "ready" && state.link
      ? `${window.location.origin}${shareUrl(state.link.token)}`
      : null;
  const linkStale = useMemo(
    () =>
      state.kind === "ready" && state.link
        ? isShareLinkStale({
            linkCreatedAt: state.link.createdAt,
            sessionUpdatedAt,
          })
        : false,
    [sessionUpdatedAt, state],
  );

  return (
    <DialogShell
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      title="Share chat"
      description={`Anyone with the link can read a frozen copy of "${sessionTitle}". New messages never update old links.`}
      size="sm"
      heightMode="content"
      dismissDisabled={busy}
      initialFocusRef={closeRef}
      footer={
        <>
          <button
            ref={closeRef}
            type="button"
            disabled={busy}
            onClick={onClose}
            className={DIALOG_SECONDARY_BUTTON_CLASS}
          >
            Close
          </button>
          {state.kind === "ready" && state.link ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDeactivate()}
              className={DIALOG_DANGER_BUTTON_CLASS}
            >
              {busy ? "Working…" : "Deactivate links"}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || state.kind !== "ready"}
              onClick={() => void handleGenerate()}
              className={DIALOG_PRIMARY_BUTTON_CLASS}
            >
              {busy ? "Working…" : "Generate link"}
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 overflow-x-clip px-4 py-4">
        {state.kind === "loading" ? (
          <div className="flex items-center gap-3">
            <div className="skeleton-shimmer h-4 w-40 rounded-full" />
          </div>
        ) : null}

        {state.kind === "error" ? (
          <div
            role="alert"
            className="rounded-2xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger animate-fade-in"
          >
            {state.message}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-2 font-medium underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        ) : null}

        {state.kind === "ready" ? (
          <div className="flex items-center gap-2.5 rounded-2xl bg-white/[0.04] px-3.5 py-3">
            {state.link ? (
              <>
                <Link2
                  className="size-4 shrink-0 text-text-muted"
                  strokeWidth={1.75}
                />
                {linkStale ? (
                  <p className="min-w-0 flex-1 truncate text-sm text-text">
                    Public link activated
                  </p>
                ) : (
                  <p
                    title={activeLink ?? undefined}
                    className="min-w-0 flex-1 truncate font-mono text-xs text-text"
                  >
                    {activeLink}
                  </p>
                )}
                <span className="relative inline-flex shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      linkStale
                        ? void handleGenerate()
                        : void handleCopyLink(state.link!.token)
                    }
                    aria-label={
                      linkStale ? "Generate a fresh link" : "Copy link"
                    }
                    title={linkStale ? "Generate a fresh link" : "Copy link"}
                    className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? (
                      <Loader2
                        className="size-4 animate-spin motion-reduce:animate-none"
                        strokeWidth={1.75}
                      />
                    ) : feedback === "copied" ? (
                      <Check className="size-4" strokeWidth={1.75} />
                    ) : (
                      <Copy className="size-4" strokeWidth={1.75} />
                    )}
                  </button>
                  <AutoDismissPopover
                    open={feedback !== null}
                    onDismiss={() => setFeedback(null)}
                    className="right-0 left-auto translate-x-0"
                  >
                    {feedback === "generated" ? "New link copied" : "Link copied"}
                  </AutoDismissPopover>
                </span>
              </>
            ) : (
              <>
                <Share2
                  className="size-4 shrink-0 text-text-muted"
                  strokeWidth={1.75}
                />
                <p className="text-sm text-text">Not shared</p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
}
