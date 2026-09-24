import { useEffect, useState } from "react";
import { CountBadge } from "#/components/ui/count-badge";
import {
  listArtifacts,
  type ArtifactListItem,
  type ArtifactType,
} from "#/lib/api-artifacts";

const TABS: Array<{ type: ArtifactType; label: string }> = [
  { type: "document", label: "Docs" },
  { type: "image", label: "Images" },
  { type: "site", label: "Sites" },
  { type: "task", label: "Tasks" },
];

/**
 * Left-sidebar artifact rail: tab counts + scoped item list.
 * Navigation only — previews and actions live in the right rail / chat.
 */
export function ArtifactsRail({ sessionId }: { sessionId: string }) {
  const [tab, setTab] = useState<ArtifactType>("document");
  const [items, setItems] = useState<ArtifactListItem[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    void Promise.all(
      TABS.map((t) => listArtifacts({ sessionId, type: t.type }).catch(() => [] as ArtifactListItem[])),
    )
      .then((pages) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        pages.forEach((page, i) => {
          next[TABS[i]!.type] = page.length;
        });
        setCounts(next);
        setItems(pages[TABS.findIndex((t) => t.type === tab)] ?? []);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, tab]);

  return (
    <section aria-label="Artifacts" className="flex min-h-0 flex-col gap-2">
      <div role="tablist" aria-label="Artifact types" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.type}
            type="button"
            role="tab"
            aria-selected={tab === t.type}
            onClick={() => setTab(t.type)}
            className={
              tab === t.type
                ? "inline-flex h-7 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium text-accent"
                : "inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-text-muted hover:text-text"
            }
          >
            {t.label}
            <CountBadge count={counts[t.type] ?? 0} label={`${t.label} artifacts`} />
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      ) : items === null ? (
        <div className="flex flex-col gap-1.5" aria-label="Loading artifacts">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-shimmer h-8 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-text-faint">Nothing here yet — ask the agent to create one.</p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          {items.map((item, i) => (
            <li
              key={item.id ?? item.sessionId ?? i}
              className="truncate rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-text-muted"
            >
              {item.caption ?? item.filename ?? item.title ?? item.sessionId ?? item.id}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
