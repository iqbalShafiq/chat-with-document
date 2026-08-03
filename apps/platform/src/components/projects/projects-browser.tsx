import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderKanban,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  createProject,
  deleteProject,
  listProjects,
  type ProjectListItem,
} from "#/lib/api";
import { formatRelativeUpdatedAt } from "#/lib/session-history";
import { useDebouncedValue } from "#/hooks/use-debounced-value";
import { WorkspaceMainPane } from "#/components/layout/workspace-main-pane";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import { DialogShell } from "#/components/ui/dialog-shell";
import {
  FormTextAreaField,
  FormTextField,
} from "#/components/ui/form-field";
import { PopoverMenu } from "#/components/ui/popover-menu";

function ProjectCardMenu({
  onDelete,
}: {
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Project menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-white/[0.06] hover:text-text"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </button>
      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        align="end"
        label="Project actions"
        className="!bottom-auto top-full mt-1.5 mb-0"
        items={[
          {
            id: "delete",
            label: "Delete project",
            description: "Cascade remove chats and documents",
            icon: <Trash2 className="size-3.5" strokeWidth={1.75} />,
            onSelect: onDelete,
          },
        ]}
      />
    </div>
  );
}

export function ProjectsBrowser({
  activeProjectId,
  onOpenProject,
}: {
  activeProjectId?: string | null;
  onOpenProject: (project: ProjectListItem) => void;
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [items, setItems] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createNameRef = useRef<HTMLInputElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const emptyCreateTriggerRef = useRef<HTMLButtonElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const closeCreateDialog = useCallback(() => {
    if (creating) return;
    setCreateOpen(false);
    setCreateError(null);
    setCreateName("");
    setCreateDescription("");
  }, [creating]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listProjects({
        query: debouncedQuery,
        limit: 50,
        sort: "updatedAt",
      });
      setItems(page.items);
    } catch {
      setError("Could not load projects");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await createProject({
        name,
        description: createDescription.trim() || null,
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      setItems((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
      onOpenProject(project);
    } catch (e) {
      setCreateError(
        e instanceof Error ? e.message : "Could not create project",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await deleteProject(deleteTarget.id);
      setItems((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete project");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
    <WorkspaceMainPane>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-accent">
          Project workspace
        </div>
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-tight text-text md:text-3xl">
              Your projects
            </h2>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-text-muted">
              Keep documents, chats, and citations scoped to the project they
              belong to.
            </p>
          </div>
          <button
            ref={createTriggerRef}
            type="button"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            className="inline-flex min-h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.98]"
          >
            <Plus className="size-4" strokeWidth={2} />
            Create new project
          </button>
        </div>

        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint"
              strokeWidth={1.75}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects by name…"
              className="w-full rounded-xl bg-white/[0.04] py-2.5 pl-10 pr-3 text-sm text-text outline-none ring-1 ring-white/[0.08] transition placeholder:text-text-faint focus:bg-white/[0.055] focus:ring-2 focus:ring-accent-ring"
            />
          </label>
        </div>

        <div className="mb-3 flex items-center justify-between text-xs text-text-faint">
          <span>
            {loading ? "Loading…" : `${items.length} project${items.length === 1 ? "" : "s"}`}
          </span>
          <span>Each project keeps its own context</span>
        </div>

        {error ? (
          <div className="mb-4 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-2xl bg-white/[0.04] ring-1 ring-white/[0.06]"
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl bg-white/[0.03] px-6 py-16 text-center ring-1 ring-white/[0.06]">
            <FolderKanban
              className="mb-3 size-8 text-text-faint"
              strokeWidth={1.5}
            />
            <p className="text-sm font-medium text-text">No projects yet</p>
            <p className="mt-1 max-w-sm text-sm text-text-muted">
              Create a project to group long-running work and isolate document
              context from standalone chats.
            </p>
            <button
              ref={emptyCreateTriggerRef}
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
              className="mt-5 inline-flex min-h-9 cursor-pointer items-center rounded-xl bg-accent px-3.5 text-sm font-medium text-canvas transition hover:bg-accent-hover active:scale-[0.98]"
            >
              Create project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((project) => {
              const isCurrent = activeProjectId === project.id;
              return (
                <article
                  key={project.id}
                  className={`group relative flex flex-col rounded-2xl bg-white/[0.035] p-4 text-left ring-1 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.05] ${
                    isCurrent
                      ? "ring-accent/50 shadow-[0_0_0_1px_rgba(232,163,23,0.15)]"
                      : "ring-white/[0.07] hover:ring-white/[0.12]"
                  }`}
                >
                  <div className="mb-3 flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => onOpenProject(project)}
                      className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-text-muted">
                        <FolderKanban className="size-5" strokeWidth={1.6} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold tracking-tight text-text">
                            {project.name}
                          </span>
                          {isCurrent ? (
                            <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                              Current
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-faint">
                          Workspace
                        </span>
                      </span>
                    </button>
                    <ProjectCardMenu
                      onDelete={() => setDeleteTarget(project)}
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenProject(project)}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                  >
                    <p className="line-clamp-2 min-h-[2.5rem] text-sm leading-relaxed text-text-muted">
                      {project.description?.trim() ||
                        "No description yet."}
                    </p>
                    <div className="mt-4 flex items-end justify-between gap-3 border-t border-white/[0.06] pt-3">
                      <div>
                        <div className="text-[10px] font-medium uppercase tracking-wide text-text-faint">
                          Documents
                        </div>
                        <div className="text-sm font-medium text-text">
                          {project.documentCount} docs
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-medium uppercase tracking-wide text-text-faint">
                          Updated
                        </div>
                        <div className="text-sm text-text-muted">
                          {formatRelativeUpdatedAt(project.updatedAt)}
                        </div>
                      </div>
                    </div>
                    {isCurrent ? (
                      <div className="mt-3 flex items-center gap-1.5 text-xs text-accent">
                        <span className="size-1.5 rounded-full bg-accent" />
                        Current project
                      </div>
                    ) : (
                      <div className="mt-3 text-xs text-text-faint">
                        {project.chatCount} chat
                        {project.chatCount === 1 ? "" : "s"}
                      </div>
                    )}
                  </button>
                </article>
              );
            })}
          </div>
        )}
    </WorkspaceMainPane>

      <DialogShell
        open={createOpen}
        onClose={closeCreateDialog}
        title="Create project"
        description="Chats and documents stay isolated inside this workspace"
        size="sm"
        heightMode="content"
        dismissDisabled={creating}
        initialFocusRef={createNameRef}
        restoreFocusRef={
          items.length === 0 ? emptyCreateTriggerRef : createTriggerRef
        }
        footer={
          <>
            <button
              type="button"
              disabled={creating}
              onClick={closeCreateDialog}
              className={DIALOG_SECONDARY_BUTTON_CLASS}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="create-project-form"
              disabled={creating || !createName.trim()}
              className={DIALOG_PRIMARY_BUTTON_CLASS}
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </>
        }
      >
        <form
          id="create-project-form"
          className="flex flex-col gap-4 px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
          noValidate
        >
          <FormTextField
            ref={createNameRef}
            label="Name"
            name="name"
            value={createName}
            onChange={(e) => {
              setCreateName(e.target.value);
              if (createError) setCreateError(null);
            }}
            placeholder="e.g. Client Onboarding"
            autoComplete="off"
            required
            maxLength={120}
            disabled={creating}
            error={createError}
          />
          <FormTextAreaField
            label="Description"
            optional
            name="description"
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
            placeholder="What belongs in this workspace?"
            rows={3}
            maxLength={2000}
            disabled={creating}
          />
        </form>
      </DialogShell>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete project?"
        description={
          deleteTarget
            ? `“${deleteTarget.name}” and all of its chats, documents, and embeddings will be permanently removed. Standalone chats are not affected.`
            : ""
        }
        confirmLabel={deleting ? "Deleting…" : "Delete project"}
        variant="danger"
        busy={deleting}
        onCancel={() => {
          if (deleting) return;
          setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}
