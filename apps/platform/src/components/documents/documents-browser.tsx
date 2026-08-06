import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileText, FolderKanban, Search, Trash2 } from "lucide-react";
import { DocumentPreviewModal } from "#/components/documents/document-preview-modal";
import { DocumentRow } from "#/components/documents/document-row";
import { WorkspaceMainPane } from "#/components/layout/workspace-main-pane";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import { Select } from "#/components/ui/select";
import { useDebouncedValue } from "#/hooks/use-debounced-value";
import { useInfiniteScrollSentinel } from "#/hooks/use-infinite-scroll-sentinel";
import {
  deleteUserDocument,
  listProjects,
  listUserDocuments,
  type ProjectListItem,
  type UserLibraryDocument,
} from "#/lib/api";
import { formatBytes } from "#/lib/documents/format-bytes";

const PAGE_SIZE = 30;
const ALL_PROJECTS = "__all_projects__";

type Group = {
  key: string;
  label: string;
  items: UserLibraryDocument[];
};

export function DocumentsBrowser() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [selectedProjectId, setSelectedProjectId] = useState(ALL_PROJECTS);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [items, setItems] = useState<UserLibraryDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<UserLibraryDocument | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<UserLibraryDocument | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
const removeTimerRef = useRef<number | null>(null);
const lastDeleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const loadMoreLock = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void listProjects({ limit: 50, sort: "name" })
      .then((page) => {
        if (!cancelled) setProjects(page.items);
      })
      .catch(() => {
        // Keep the all-documents view usable if project metadata is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (removeTimerRef.current !== null) {
        window.clearTimeout(removeTimerRef.current);
      }
    };
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listUserDocuments({
        query: debouncedQuery,
        limit: PAGE_SIZE,
        scope: "browser",
        projectId:
          selectedProjectId === ALL_PROJECTS ? undefined : selectedProjectId,
      });
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch {
      setError("Could not load documents");
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, selectedProjectId]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loadMoreLock.current) return;
    loadMoreLock.current = true;
    setLoadingMore(true);
    try {
      const page = await listUserDocuments({
        query: debouncedQuery,
        cursor: nextCursor,
        limit: PAGE_SIZE,
        scope: "browser",
        projectId:
          selectedProjectId === ALL_PROJECTS ? undefined : selectedProjectId,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((d) => d.id));
        const merged = [...prev];
        for (const item of page.items) {
          if (!seen.has(item.id)) merged.push(item);
        }
        return merged;
      });
      setNextCursor(page.nextCursor);
    } catch {
      // keep list; user can scroll again
    } finally {
      setLoadingMore(false);
      loadMoreLock.current = false;
    }
  }, [debouncedQuery, loadingMore, nextCursor, selectedProjectId]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteUserDocument(deleteTarget.id);
      const deletedId = deleteTarget.id;
      setDeleteTarget(null);
      setPreviewDoc((prev) => (prev && prev.id === deletedId ? null : prev));
      setRemovingId(deletedId);
      if (removeTimerRef.current !== null) {
        window.clearTimeout(removeTimerRef.current);
      }
      removeTimerRef.current = window.setTimeout(() => {
        setItems((prev) => prev.filter((d) => d.id !== deletedId));
        setRemovingId((current) => (current === deletedId ? null : current));
        removeTimerRef.current = null;
      }, 200);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Could not delete document",
      );
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting]);

  useInfiniteScrollSentinel({
    sentinelRef,
    hasMore: Boolean(nextCursor),
    loading,
    loadingMore,
    onLoadMore: () => {
      void loadMore();
    },
    itemCount: items.length,
  });

  const hasActiveFilter =
    Boolean(debouncedQuery) || selectedProjectId !== ALL_PROJECTS;

  const groups = useMemo((): Group[] => {
    const map = new Map<string, Group>();
    for (const doc of items) {
      const key = doc.projectId ?? "__standalone__";
      const label = doc.projectName?.trim() || "Standalone";
      const group = map.get(key);
      if (group) {
        group.items.push(doc);
      } else {
        map.set(key, { key, label, items: [doc] });
      }
    }
    // Standalone last; projects alpha
    return [...map.values()].sort((a, b) => {
      if (a.key === "__standalone__") return 1;
      if (b.key === "__standalone__") return -1;
      return a.label.localeCompare(b.label);
    });
  }, [items]);

  return (
    <>
      <WorkspaceMainPane scroll={false}>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-text-faint">
          Library
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-text">
          Documents
        </h2>
        <p className="mt-1.5 text-sm text-text-muted">
          Browse uploads across projects. Preview only — add files from a chat.
        </p>

        <div className="mt-5 flex shrink-0 flex-col gap-2 sm:flex-row">
          <label className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint"
              strokeWidth={1.75}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by filename…"
              className="w-full rounded-xl bg-white/[0.04] py-2.5 pl-10 pr-3 text-sm text-text outline-none ring-1 ring-white/[0.08] transition placeholder:text-text-faint focus:bg-white/[0.055] focus:ring-2 focus:ring-accent-ring"
            />
          </label>

          <Select
            ariaLabel="Filter documents by project"
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            leadingIcon={<FolderKanban className="size-4" strokeWidth={1.75} />}
            className="shrink-0 sm:w-56"
            options={[
              { value: ALL_PROJECTS, label: "All groups" },
              ...projects.map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
          />
        </div>

        {error ? (
          <div className="mt-4 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}

        {/*
          Bottom padding lives on the scroll content (not the clipped viewport)
          so the last row can scroll fully into view — clipToPadding=false style.
        */}
        <div
          ref={listScrollRef}
          className="chat-scroll mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {loading && items.length === 0 ? (
            <div className="space-y-2 pb-10">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-xl bg-white/[0.04]"
                />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl bg-white/[0.03] px-6 py-16 text-center ring-1 ring-white/[0.06]">
              <FileText
                className="mb-3 size-8 text-text-faint"
                strokeWidth={1.5}
              />
              <p className="text-sm font-medium text-text">
                {hasActiveFilter ? "No matching documents" : "No documents yet"}
              </p>
              <p className="mt-1 max-w-sm text-sm text-text-muted">
                {hasActiveFilter
                  ? "Try a different search term or choose another group."
                  : "Upload files from a chat composer. They will show up here, grouped by project when applicable."}
              </p>
            </div>
          ) : (
            <div className="space-y-6 pb-10 md:pb-12">
              {groups.map((group) => (
                <section key={group.key}>
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
                      {group.label}
                    </h3>
                    <span className="font-mono text-[10px] text-text-faint/80">
                      {group.items.length} {group.items.length === 1 ? "file" : "files"}
                    </span>
                  </div>
                  <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {group.items.map((doc) => (
                      <li
                        key={doc.id}
                        className={
                          removingId === doc.id ? "animate-fade-out" : undefined
                        }
                      >
                        <DocumentRow
                          layout="card"
                          filename={doc.filename}
                          summary={doc.firstPageSummary}
                          meta={`${formatBytes(doc.sizeBytes)}${
                            doc.pageCount
                              ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`
                              : ""
                          }`}
                          trailing={
                            <div className="flex w-full items-center justify-end gap-1.5">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Preview full content"
                                title="Preview full content"
                                onClick={() => setPreviewDoc(doc)}
                              >
                                <Eye className="size-4" strokeWidth={1.75} />
                              </Button>
                              <Button
                                variant="danger"
                                size="icon"
                                aria-label="Delete document"
                                title="Delete document"
                                onClick={(event) => {
                                  lastDeleteTriggerRef.current =
                                    event.currentTarget;
                                  setDeleteTarget(doc);
                                }}
                              >
                                <Trash2 className="size-4" strokeWidth={1.75} />
                              </Button>
                            </div>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <div ref={sentinelRef} className="h-4 shrink-0" aria-hidden />
              {loadingMore ? (
                <p className="py-2 text-center text-xs text-text-faint">
                  Loading more…
                </p>
              ) : null}
            </div>
          )}
        </div>
      </WorkspaceMainPane>

      <DocumentPreviewModal
        open={Boolean(previewDoc)}
        document={
          previewDoc
            ? {
                id: previewDoc.id,
                filename: previewDoc.filename,
                pageCount: previewDoc.pageCount,
              }
            : null
        }
        onClose={() => setPreviewDoc(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete document?"
        description={
          deleteTarget
            ? `“${deleteTarget.filename}” and its embeddings will be permanently removed from your library.`
            : ""
        }
        confirmLabel="Delete document"
        busy={deleting}
        error={deleteError}
        restoreFocusRef={lastDeleteTriggerRef}
        onCancel={() => {
          if (deleting) return;
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}
