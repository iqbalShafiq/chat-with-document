import { useEffect, useState } from "react";
import { API_BASE, apiFetch } from "#/lib/api";
import type { SiteLiveView } from "#/lib/chat/client-data";

const FRAME_POLL_MS = 350;

/**
 * Poll the authenticated live-frame endpoint while a browse session is active.
 * 204/error keeps the previous frame — a transient miss must not blank the
 * panel. Object URLs are revoked on replacement and unmount.
 */
export function useSiteLiveFrame(sessionId: string, active: boolean): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let created: string | null = null;

    const tick = async () => {
      try {
        const response = await apiFetch(
          `${API_BASE}/api/sites/live/${encodeURIComponent(sessionId)}/frame?t=${Date.now()}`,
        );
        if (cancelled) return;
        if (response.status === 204 || !response.ok) return; // keep the last frame
        const blob = await response.blob();
        if (cancelled) return;
        const next = URL.createObjectURL(
          blob.type ? blob : new Blob([blob], { type: "image/jpeg" }),
        );
        const previous = created;
        created = next;
        setSrc(next);
        if (previous) URL.revokeObjectURL(previous);
      } catch {
        // Keep the last frame; the next tick may recover.
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, FRAME_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (created) URL.revokeObjectURL(created);
    };
  }, [sessionId, active]);

  return src;
}

export function SiteLiveCard({
  view,
  sessionId,
  onHide,
}: {
  view: SiteLiveView;
  sessionId: string;
  onHide: () => void;
}) {
  const active = view.state === "started";
  const src = useSiteLiveFrame(sessionId, active);

  if (!active) return null;
  const label = view.label ?? view.siteId;

  return (
    <figure
      aria-label={`Live view ${label}`}
      className="w-full overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3"
    >
      <figcaption className="mb-2 flex items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 animate-pulse rounded-full bg-accent"
        />
        <span className="truncate text-xs font-medium text-text">
          Live · {label}
        </span>
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide live view"
          className="ml-auto inline-flex h-6 cursor-pointer items-center rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 text-[11px] font-medium text-text-muted transition duration-150 hover:bg-white/10 hover:text-text active:scale-[0.97]"
        >
          Hide
        </button>
      </figcaption>
      {src ? (
        <img
          src={src}
          alt={`Livestream ${label}`}
          className="aspect-video w-full rounded-xl border border-white/[0.08] bg-black/40 object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="aspect-video w-full animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.04]"
        />
      )}
    </figure>
  );
}
