import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { ManagementRow } from "#/components/ui/management-row";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type WorkspaceTask,
} from "#/lib/api-artifacts";

/** Right-rail tasks panel: scoped checklist with inbox/doing/done states. */
export function TasksPanel({ sessionId }: { sessionId: string }) {
  const [tasks, setTasks] = useState<WorkspaceTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmDoneId, setConfirmDoneId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [editDescDraft, setEditDescDraft] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [subDrafts, setSubDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    setError(null);
    void listTasks(sessionId)
      .then(setTasks)
      .catch((fetchError) => {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load tasks");
      });
  }, [sessionId]);

  useEffect(() => {
    setTasks(null);
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="h-7 cursor-pointer rounded-lg border border-white/[0.08] px-2.5 text-[11px] text-text-muted hover:text-text"
        >
          Retry
        </button>
      </div>
    );
  }
  if (tasks === null) {
    return (
      <div className="flex flex-col gap-1.5" aria-label="Loading tasks">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton-shimmer h-10 rounded-xl" />
        ))}
      </div>
    );
  }
  return (
    <section aria-label="Tasks" className="flex flex-col gap-2">
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (creating || !draft.trim()) return;
          setCreating(true);
          void createTask({ sessionId, title: draft.trim() })
            .then(() => {
              setDraft("");
              setCreating(false);
              refresh();
            })
            .catch((createError) => {
              setCreating(false);
              setError(createError instanceof Error ? createError.message : "Create failed");
            });
        }}
      >
        <input
          type="text"
          value={draft}
          maxLength={200}
          disabled={creating}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New task…"
          aria-label="New task title"
          className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-text placeholder:text-text-faint outline-none focus:border-accent/40 disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={creating || !draft.trim()}
          className="h-8 shrink-0 cursor-pointer rounded-lg bg-accent px-3 text-[11px] font-semibold text-canvas disabled:opacity-40"
        >
          Add
        </button>
      </form>
      {tasks.length === 0 ? (
        <p className="text-[11px] text-text-faint">No tasks yet — add one or ask the agent.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => {
            const doneCount = task.subtasks.filter((s) => s.done).length;
            const expanded = expandedId === task.id;
            return (
              <li key={task.id} className="flex flex-col gap-1">
                {renamingId === task.id ? (
                  <form
                    className="flex flex-col gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!renameDraft.trim()) return;
                      const title = renameDraft.trim();
                      const description = editDescDraft.trim();
                      setRenamingId(null);
                      void updateTask(task.id, {
                        sessionId,
                        title,
                        description: description ? description : null,
                      }).then(refresh);
                    }}
                  >
                    <input
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      type="text"
                      value={renameDraft}
                      maxLength={200}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      aria-label={`Rename ${task.title}`}
                      className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-text outline-none focus:border-accent/40"
                    />
                    <input
                      type="text"
                      value={editDescDraft}
                      maxLength={2000}
                      onChange={(event) => setEditDescDraft(event.target.value)}
                      placeholder="Description (optional)…"
                      aria-label={`Description for ${task.title}`}
                      className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-text placeholder:text-text-faint outline-none focus:border-accent/40"
                    />
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setRenamingId(null)}
                        className="h-7 cursor-pointer rounded-md px-2 text-[11px] text-text-muted hover:text-text"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!renameDraft.trim()}
                        className="h-7 shrink-0 cursor-pointer rounded-lg bg-accent px-3 text-[11px] font-semibold text-canvas disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                  </form>
                ) : (
                  <ManagementRow
                    title={
                      task.subtasks.length > 0
                        ? `${task.title} (${doneCount}/${task.subtasks.length})`
                        : task.title
                    }
                    subtitle={task.description ?? task.status}
                    enabled={task.status === "done"}
                    onToggle={() => {
                      const next = task.status === "done" ? "inbox" : "done";
                      if (next === "done") {
                        setConfirmDoneId(task.id);
                        return;
                      }
                      void updateTask(task.id, { sessionId, status: next }).then(refresh);
                    }}
                    toggleLabel={`Mark ${task.title} done`}
                    onEdit={() => {
                      setRenameDraft(task.title);
                      setEditDescDraft(task.description ?? "");
                      setRenamingId(task.id);
                    }}
                    editLabel={`Edit ${task.title}`}
                    onDelete={() => {
                      setConfirmDeleteId(task.id);
                    }}
                    deleteLabel={`Delete ${task.title}`}
                  />
                )}
                {(task.subtasks.length > 0 || task.description) && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} details for ${task.title}`}
                    onClick={() => setExpandedId(expanded ? null : task.id)}
                    className="inline-flex w-fit cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[10px] text-text-faint transition hover:bg-white/[0.06] hover:text-text"
                  >
                    <ChevronDown
                      className={`size-3 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
                    />
                    {expanded ? "Hide details" : `Details (${task.subtasks.length})`}
                  </button>
                )}
                {expanded && (
                  <div className="ml-2 flex flex-col gap-1 border-l border-white/[0.08] pl-2.5">
                    {task.description ? (
                      <p className="text-[11px] leading-relaxed text-text-muted">{task.description}</p>
                    ) : null}
                    <ul className="flex flex-col gap-1">
                      {task.subtasks.map((sub) => (
                        <li key={sub.id} className="flex items-center gap-2">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={sub.done}
                            aria-label={`Mark subtask ${sub.title} ${sub.done ? "not done" : "done"}`}
                            onClick={() => {
                              void updateTask(task.id, {
                                sessionId,
                                toggleSubtasks: [{ id: sub.id, done: !sub.done }],
                              }).then(refresh);
                            }}
                            className={`inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition ${
                              sub.done
                                ? "border-accent bg-accent text-canvas"
                                : "border-white/[0.2] bg-transparent hover:border-accent"
                            }`}
                          >
                            {sub.done ? <Check className="size-3" strokeWidth={3} /> : null}
                          </button>
                          <span
                            className={`min-w-0 flex-1 truncate text-[11px] ${sub.done ? "text-text-faint line-through" : "text-text"}`}
                          >
                            {sub.title}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove subtask ${sub.title}`}
                            onClick={() => {
                              void updateTask(task.id, {
                                sessionId,
                                removeSubtasks: [sub.id],
                              }).then(refresh);
                            }}
                            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-text-faint transition hover:bg-white/[0.08] hover:text-text"
                          >
                            <X className="size-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <form
                      className="flex gap-1.5"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const title = (subDrafts[task.id] ?? "").trim();
                        if (!title) return;
                        setSubDrafts((d) => ({ ...d, [task.id]: "" }));
                        void updateTask(task.id, { sessionId, addSubtasks: [title] }).then(refresh);
                      }}
                    >
                      <input
                        type="text"
                        value={subDrafts[task.id] ?? ""}
                        maxLength={200}
                        onChange={(event) =>
                          setSubDrafts((d) => ({ ...d, [task.id]: event.target.value }))
                        }
                        placeholder="Add subtask…"
                        aria-label={`Add subtask to ${task.title}`}
                        className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-text placeholder:text-text-faint outline-none focus:border-accent/40"
                      />
                      <button
                        type="submit"
                        disabled={!(subDrafts[task.id] ?? "").trim()}
                        className="h-7 shrink-0 cursor-pointer rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-canvas disabled:opacity-40"
                      >
                        Add
                      </button>
                    </form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirmDoneId !== null}
        title="Mark done?"
        description="The task stays in the list so the agent and you share history."
        confirmLabel="Mark done"
        onCancel={() => setConfirmDoneId(null)}
        onConfirm={() => {
          const id = confirmDoneId;
          setConfirmDoneId(null);
          if (id) void updateTask(id, { sessionId, status: "done" }).then(refresh);
        }}
      />
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete task?"
        description="This permanently removes the task for you and the agent."
        confirmLabel="Delete"
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) void deleteTask(id, sessionId).then(refresh);
        }}
      />
    </section>
  );
}
