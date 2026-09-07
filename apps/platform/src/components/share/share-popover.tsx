import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Share2, ShieldOff } from "lucide-react";
import { copyToClipboard } from "#/lib/clipboard";
import {
  ApiAuthError,
  createShareLink,
  deactivateShareLinks,
  fetchShareStatus,
  shareUrl,
} from "#/lib/api";
import { AutoDismissPopover } from "#/components/ui/auto-dismiss-popover";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";
import { DialogShell } from "#/components/ui/dialog-shell";

type ShareState =
  | { kind: "loading" }
  | { kind: "ready"; active: boolean; token: string | null }
  | { kind: "error"; message: string };

/**
 * Share popover: status, one-shot Generate (token shown once), Deactivate
 * all. The owner is never given a listing of past tokens — closing the
 * dialog drops the token from memory for good.
 */
export function SharePopover({
  sessionId,
  sessionTitle,
  open,
  onClose,
  onStatusChange,
  onAuthFailure,
}: {
  sessionId: string;
  sessionTitle: string;
  open: boolean;
  onClose: () => void;
  onStatusChange?: (sessionId: string, active: boolean) => void;
  onAuthFailure?: () => void;
}) {
  const [state, setState] = useState<ShareState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const status = await fetchShareStatus(sessionId);
      setState({ kind: "ready", active: status.active, token: null });
      onStatusChange?.(sessionId, status.active);
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
      setCopied(false);
      void load();
    } else {
      // Dropping the token on close is the privacy guarantee: past links
      // cannot be viewed again, only replaced or deactivated.
      setState({ kind: "loading" });
    }
  }, [load, open]);

  const handleGenerate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await createShareLink(sessionId);
      setState({ kind: "ready", active: true, token: created.token });
      onStatusChange?.(sessionId, true);
      const ok = await copyToClipboard(
        `${window.location.origin}${shareUrl(created.token)}`,
      );
      setCopied(ok);
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
  }, [busy, onAuthFailure, onStatusChange, sessionId]);

  const handleCopyAgain = useCallback(async (token: string) => {
    const ok = await copyToClipboard(
      `${window.location.origin}${shareUrl(token)}`,
    );
    setCopied(ok);
  }, []);

  const handleDeactivate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deactivateShareLinks(sessionId);
      setState({ kind: "ready", active: false, token: null });
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
        <button
          ref={closeRef}
          type="button"
          disabled={busy}
          onClick={onClose}
          className={DIALOG_SECONDARY_BUTTON_CLASS}
        >
          Done
        </button>
      }
    >
      <div className="flex flex-col gap-4 px-4 py-4">
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
          <>
            <div className="flex items-center gap-2.5 rounded-2xl bg-white/[0.04] px-3.5 py-3">
              <Share2 className="size-4 shrink-0 text-text-muted" strokeWidth={1.75} />
              <p className="text-sm text-text">
                {state.active ? (
                  <>
                    Shared link <strong>active</strong>
                  </>
                ) : (
                  <>Not shared</>
                )}
              </p>
            </div>

            {state.token ? (
              <div className="flex flex-col gap-2 rounded-2xl border border-accent/30 bg-accent/[0.07] px-3.5 py-3 animate-fade-in">
                <p className="text-xs font-medium text-text">
                  Copy it now — this link is shown once and never again.
                </p>
                <p className="break-all font-mono text-xs text-text-muted">
                  {`${window.location.origin}${shareUrl(state.token)}`}
                </p>
                <span className="relative inline-flex self-start">
                  <button
                    type="button"
                    onClick={() => void handleCopyAgain(state.token!)}
                    className={DIALOG_PRIMARY_BUTTON_CLASS}
                  >
                    {copied ? (
                      <Check className="size-3.5" strokeWidth={2} />
                    ) : (
                      <Copy className="size-3.5" strokeWidth={2} />
                    )}
                    {copied ? "Copied" : "Copy link"}
                  </button>
                  <AutoDismissPopover
                    open={copied}
                    onDismiss={() => setCopied(false)}
                  >
                    Copied
                  </AutoDismissPopover>
                </span>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleGenerate()}
                className={DIALOG_PRIMARY_BUTTON_CLASS}
              >
                {busy
                  ? "Working…"
                  : state.active
                    ? "Generate new link"
                    : "Generate link"}
              </button>
              {state.active ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDeactivate()}
                  className={DIALOG_SECONDARY_BUTTON_CLASS}
                >
                  <ShieldOff className="size-3.5" strokeWidth={1.75} />
                  Deactivate all
                </button>
              ) : null}
            </div>
            <p className="text-[11px] leading-relaxed text-text-faint">
              Deactivating turns off every link of this chat at once. Deleting
              the chat deletes its links too. Readers who send a message get
              their own independent copy.
            </p>
          </>
        ) : null}
      </div>
    </DialogShell>
  );
}
