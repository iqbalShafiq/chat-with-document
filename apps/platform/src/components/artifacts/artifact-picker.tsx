import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  getArtifact,
  listArtifacts,
  type ArtifactListItem,
  type ArtifactType,
} from "#/lib/api-artifacts";

/** Prefix contract shared with the agent (see ARTIFACT_CHOICE_PREFIX). */
export const ARTIFACT_CHOICE_PREFIX = "artifact:";

export function decodeArtifactChoice(value: string): {
  type: ArtifactType;
  id: string;
} | null {
  if (!value.startsWith(ARTIFACT_CHOICE_PREFIX)) return null;
  const rest = value.slice(ARTIFACT_CHOICE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const type = rest.slice(0, sep) as ArtifactType;
  const id = rest.slice(sep + 1);
  if (!id) return null;
  return { type, id };
}

/**
 * Visual artifact picker: radio list with thumbnails/labels for images,
 * documents, sites, and tasks. Used standalone and inside clarification
 * cards when the agent offers `artifact:<type>:<id>` choices.
 */
export function ArtifactPicker({
  sessionId,
  artifactType,
  value,
  onSelect,
  autoLoad = true,
  candidates,
}: {
  sessionId: string;
  artifactType: ArtifactType;
  value: string | null;
  onSelect: (id: string) => void;
  autoLoad?: boolean;
  /** Explicit candidate ids (e.g. from agent clarification choices). */
  candidates?: string[];
}) {
  const [items, setItems] = useState<ArtifactListItem[] | null>(autoLoad || candidates ? null : []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!autoLoad && !candidates) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    const load = candidates
      ? Promise.all(
          candidates.map((id) => getArtifact({ id, type: artifactType, sessionId }).catch(() => null)),
        ).then((rows) => rows.filter((r): r is ArtifactListItem => r !== null))
      : listArtifacts({ sessionId, type: artifactType });
    void load
      .then((loaded) => {
        if (!cancelled) setItems(loaded);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, artifactType, autoLoad, candidates]);

  if (error) {
    return (
      <p role="alert" className="text-[11px] text-danger">
        {error}
      </p>
    );
  }
  if (items === null) {
    return (
      <div className="flex flex-col gap-1.5" aria-label="Loading artifacts">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton-shimmer h-9 rounded-lg" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-[11px] text-text-faint">
        No {artifactType} artifacts in this scope yet.
      </p>
    );
  }
  return (
    <div role="radiogroup" aria-label={`Choose ${artifactType}`} className="flex flex-col gap-1.5">
      {items.map((item) => {
        const id = item.id ?? item.sessionId ?? "";
        const selected = value === id;
        const label =
          item.caption ?? item.filename ?? item.title ?? item.sessionId ?? id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(id)}
            className={
              selected
                ? "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-left text-[11px] font-medium text-accent transition active:scale-[0.98]"
                : "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-left text-[11px] font-medium text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.98]"
            }
          >
            {selected ? <Check className="size-3 shrink-0" strokeWidth={2.5} /> : null}
            {item.type === "image" ? (
              <img
                src={`/api/images/${encodeURIComponent(id)}`}
                alt=""
                aria-hidden
                className="size-7 shrink-0 rounded-md object-cover"
                loading="lazy"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
