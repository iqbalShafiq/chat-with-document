import { useEffect, useRef, useState } from "react";
import { Check, Eye } from "lucide-react";
import {
  getArtifact,
  listArtifacts,
  type ArtifactListItem,
  type ArtifactType,
} from "#/lib/api-artifacts";
import { API_BASE } from "#/lib/api";
import { DialogShell } from "#/components/ui/dialog-shell";
import { DocumentPreviewModal } from "#/components/documents/document-preview-modal";

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
 * Empty-state copy: distinguishes "scope is empty" from "the offered
 * choices could not be loaded" (usually an agent scoping error).
 */
export function describeEmptyArtifacts(input: {
  artifactType: ArtifactType;
  offeredCount: number;
  loadedCount: number;
}): string {
  if (input.offeredCount > 0 && input.loadedCount === 0) {
    return `Couldn't load the offered ${input.artifactType} choices — they may be out of scope.`;
  }
  return `No ${input.artifactType} artifacts in this scope yet.`;
}

function itemLabel(item: ArtifactListItem): string {
  const id = item.id ?? item.sessionId ?? "";
  return item.caption ?? item.filename ?? item.title ?? item.sessionId ?? id;
}

function itemId(item: ArtifactListItem): string {
  return item.id ?? item.sessionId ?? "";
}

/** Row-level preview is offered for sites and documents (reports). */
function previewKind(item: ArtifactListItem, fallback: ArtifactType): "site" | "document" | null {
  const kind = item.type ?? fallback;
  if (kind === "site") return "site";
  if (kind === "document") return "document";
  return null;
}

function resolveSitePreviewSrc(item: ArtifactListItem): string | null {
  const raw =
    item.previewUrl ??
    (typeof item.version === "number"
      ? `/api/sites/${item.siteId ?? item.id}/v${item.version}/preview/index.html`
      : null);
  if (!raw) return null;
  return raw.startsWith("/api/sites/") ? `${API_BASE}${raw}` : raw;
}

/**
 * Visual artifact picker: radio list with thumbnails/labels for images,
 * documents, sites, and tasks. Used standalone and inside clarification
 * cards when the agent offers `artifact:<type>:<id>` choices.
 *
 * Site and document rows carry an eye button that opens a full preview
 * modal without selecting the row — so pinning stops being guesswork.
 */
export function ArtifactPicker({
  sessionId,
  artifactType,
  value,
  onSelect,
  autoLoad = true,
  candidates,
  filter,
  emptyHint,
}: {
  sessionId: string;
  artifactType: ArtifactType;
  value: string | null;
  onSelect: (id: string) => void;
  autoLoad?: boolean;
  /** Explicit candidate ids (e.g. from agent clarification choices). */
  candidates?: string[];
  /** Client-side narrowing (e.g. reports only inside documents). */
  filter?: (item: ArtifactListItem) => boolean;
  /** Override for the empty-scope message. */
  emptyHint?: string;
}) {
  const [items, setItems] = useState<ArtifactListItem[] | null>(autoLoad || candidates ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<ArtifactListItem | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

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
  const shown = items === null ? null : filter ? items.filter(filter) : items;
  if (shown !== null && shown.length === 0) {
    return (
      <p className="text-[11px] text-text-faint">
        {emptyHint ??
          describeEmptyArtifacts({
            artifactType,
            offeredCount: candidates?.length ?? 0,
            loadedCount: 0,
          })}
      </p>
    );
  }
  const previewType = previewItem ? (previewItem.type ?? artifactType) : null;
  const previewId = previewItem ? itemId(previewItem) : "";
  const previewLabel = previewItem ? itemLabel(previewItem) : "";
  const siteSrc = previewItem && previewType === "site" ? resolveSitePreviewSrc(previewItem) : null;
  const siteVersion =
    previewItem && typeof previewItem.version === "number" ? previewItem.version : null;
  return (
    <>
      <div role="radiogroup" aria-label={`Choose ${artifactType}`} className="flex flex-col gap-1.5">
        {(shown ?? []).map((item) => {
          const id = itemId(item);
          const selected = value === id;
          const label = itemLabel(item);
          const kind = previewKind(item, artifactType);
          return (
            <div key={id} className="flex items-center gap-1.5">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(id)}
                className={
                  selected
                    ? "inline-flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-left text-[11px] font-medium text-accent transition active:scale-[0.98]"
                    : "inline-flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-left text-[11px] font-medium text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.98]"
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
              {kind ? (
                <button
                  type="button"
                  aria-label={`Preview ${kind} ${label}`}
                  title={`Preview ${label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    restoreFocusRef.current = event.currentTarget;
                    setPreviewItem(item);
                  }}
                  className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.08] hover:text-text active:scale-95"
                >
                  <Eye className="size-3.5" strokeWidth={2} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {previewType === "site" ? (
        <DialogShell
          open={previewItem !== null}
          onClose={() => setPreviewItem(null)}
          title={`Preview ${previewLabel}`}
          description={siteVersion !== null ? `Site · v${siteVersion}` : "Site preview"}
          size="xl"
          restoreFocusRef={restoreFocusRef}
        >
          {siteSrc ? (
            <iframe
              title={`Preview ${previewLabel}`}
              src={siteSrc}
              sandbox="allow-scripts"
              className="min-h-0 w-full flex-1 border-0"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <p className="max-w-xs text-center text-[12px] text-text-muted">
                {typeof previewItem?.status === "string" && previewItem.status !== "ready"
                  ? `This site is still ${previewItem.status} — no preview yet.`
                  : "No preview available for this site yet."}
              </p>
            </div>
          )}
        </DialogShell>
      ) : null}
      <DocumentPreviewModal
        open={previewItem !== null && previewType === "document"}
        document={
          previewItem && previewType === "document"
            ? { id: previewId, filename: previewItem.filename ?? previewLabel }
            : null
        }
        onClose={() => {
          setPreviewItem(null);
          requestAnimationFrame(() => {
            restoreFocusRef.current?.focus();
          });
        }}
      />
    </>
  );
}
