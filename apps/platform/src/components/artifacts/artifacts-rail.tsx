import { useEffect, useState } from "react";
import { CountBadge } from "#/components/ui/count-badge";
import { SegmentedTabs } from "#/components/ui/segmented-tabs";
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
  { type: "schedule", label: "Sched" },
  { type: "web_bundle", label: "Web" },
  { type: "session", label: "Chats" },
];

/**
 * Left-sidebar artifact rail: tab counts + scoped item list.
 * Navigation only — previews and actions live in the right rail / chat.
 */
export function ArtifactsRail({ sessionId }: { sessionId: string }) {
  const [tab, setTab] = useState<ArtifactType>("document");
  const [pages, setPages] = useState<Record<string, ArtifactListItem[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One fetch per session; tab switches read the cache instead of refetching.
  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(null);
    void Promise.all(
      TABS.map((t) => listArtifacts({ sessionId, type: t.type }).catch(() => [] as ArtifactListItem[])),
    )
      .then((rows) => {
        if (cancelled) return;
        const next: Record<string, ArtifactListItem[]> = {};
        TABS.forEach((t, i) => {
          next[t.type] = rows[i] ?? [];
        });
        setPages(next);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const items = pages ? (pages[tab] ?? []) : null;
  const counts: Record<string, number> = {};
  if (pages) {
    for (const t of TABS) counts[t.type] = (pages[t.type] ?? []).length;
  }

  return (
    <section aria-label="Artifacts" className="flex min-h-0 flex-col gap-2">
      <SegmentedTabs
        label="Artifact types"
        value={tab}
        onSelect={setTab}
        options={TABS.map((t) => ({
          value: t.type,
          label: t.label,
          badge: <CountBadge count={counts[t.type] ?? 0} label={`${t.label} artifacts`} />,
        }))}
      />
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
