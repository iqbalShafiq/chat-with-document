import { useCallback, useEffect, useState, type RefObject } from "react";
import { API_BASE, apiFetch } from "#/lib/api";
import { DialogShell } from "#/components/ui/dialog-shell";

type LoadState = "loading" | "ready" | "error";

/**
 * In-chat report preview: fetch the rendered PDF through the authenticated
 * API and show it inline. The document preview pane cannot render report
 * bytes (reports have no page images), so this is the honest preview.
 */
export function ReportPdfPreview({
  open,
  reportId,
  sessionId,
  filename,
  onClose,
  restoreFocusRef,
}: {
  open: boolean;
  reportId: string;
  sessionId: string;
  filename: string;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [src, setSrc] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setState("loading");
    setSrc(null);
    void apiFetch(
      `${API_BASE}/api/reports/${encodeURIComponent(reportId)}/pdf?sessionId=${encodeURIComponent(sessionId)}`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load report (${response.status})`);
        const blob = await response.blob();
        if (cancelled) return;
        const typed = blob.type ? blob : new Blob([blob], { type: "application/pdf" });
        createdUrl = URL.createObjectURL(typed);
        setSrc(createdUrl);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [open, reportId, sessionId, retryKey]);

  const retry = useCallback(() => setRetryKey((key) => key + 1), []);

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title={`Preview ${filename}`}
      description="Report PDF"
      size="xl"
      {...(restoreFocusRef ? { restoreFocusRef } : {})}
    >
      {state === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <p role="alert" className="text-[12px] text-danger">
            Could not load this report PDF.
          </p>
          <button
            type="button"
            onClick={retry}
            className="h-7 cursor-pointer rounded-lg border border-white/[0.08] px-2.5 text-[11px] text-text-muted hover:text-text"
          >
            Retry
          </button>
        </div>
      ) : state === "ready" && src ? (
        <iframe
          title={`Preview ${filename}`}
          src={src}
          className="min-h-0 w-full flex-1 border-0"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div aria-label="Loading report" className="skeleton-shimmer h-[70%] w-full rounded-lg" />
        </div>
      )}
    </DialogShell>
  );
}
