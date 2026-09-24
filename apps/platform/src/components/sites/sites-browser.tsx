import { useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { DialogShell } from "#/components/ui/dialog-shell";
import { API_BASE } from "#/lib/api";
import { listScopeSites, type ScopeSite } from "#/lib/api-artifacts";

/**
 * Sidebar sites entry: every static site in the active session scope
 * (cross-session registry), with preview + download. Version history and
 * rollback stay in the chat build panel where the build ran.
 */
export function SitesBrowser({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  const [sites, setSites] = useState<ScopeSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setSites(null);
    setError(null);
    void listScopeSites(sessionId)
      .then((loaded) => {
        if (!cancelled) setSites(loaded);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load sites");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  if (!open) return null;
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Sites"
      description="Static sites in this scope, from any session."
      size="lg"
      heightMode="viewport"
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <div className="chat-scroll-bleed absolute inset-0 overflow-y-auto overscroll-contain p-4">
          <div className="flex flex-col gap-3">
      {!sessionId ? (
        <p className="text-[12px] text-text-muted">
          Open a chat first — sites live in the active session scope.
        </p>
      ) : error ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setSites(null);
              void listScopeSites(sessionId).then(setSites).catch((e) => {
                setError(e instanceof Error ? e.message : "Failed to load sites");
              });
            }}
            className="h-7 w-fit cursor-pointer rounded-lg border border-white/[0.08] px-2.5 text-[11px] text-text-muted hover:text-text"
          >
            Retry
          </button>
        </div>
      ) : sites === null ? (
        <div className="flex flex-col gap-1.5" aria-label="Loading sites">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-shimmer h-12 rounded-xl" />
          ))}
        </div>
      ) : sites.length === 0 ? (
        <p className="text-[12px] text-text-muted">
          No sites yet — ask the agent to build one in chat.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sites.map((site) => (
            <li
              key={site.siteId}
              className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {site.siteId.slice(0, 8)} · v{site.version}
                </p>
                <p className="truncate text-[11px] text-text-faint">{site.status}</p>
              </div>
              {site.previewUrl ? (
                <a
                  href={`${API_BASE}${site.previewUrl}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Preview site ${site.siteId.slice(0, 8)}`}
                  className="inline-flex size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.08] hover:text-text"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              ) : null}
              <a
                href={`${API_BASE}${site.downloadUrl}`}
                aria-label={`Download site ${site.siteId.slice(0, 8)}`}
                className="inline-flex size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.08] hover:text-text"
              >
                <Download className="size-3.5" />
              </a>
            </li>
          ))}
        </ul>
      )}
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
