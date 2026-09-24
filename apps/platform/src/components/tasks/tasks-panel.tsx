import { useCallback, useEffect, useState } from "react";
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
          {tasks.map((task) =>
            renamingId === task.id ? (
              <li key={task.id}>
                <form
                  className="flex gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!renameDraft.trim()) return;
                    const title = renameDraft.trim();
                    setRenamingId(null);
                    void updateTask(task.id, { sessionId, title }).then(refresh);
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
                  <button
                    type="submit"
                    disabled={!renameDraft.trim()}
                    className="h-8 shrink-0 cursor-pointer rounded-lg bg-accent px-3 text-[11px] font-semibold text-canvas disabled:opacity-40"
                  >
                    Save
                  </button>
                </form>
              </li>
            ) : (
              <ManagementRow
                key={task.id}
                title={task.title}
                subtitle={task.status}
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
                  setRenamingId(task.id);
                }}
                editLabel={`Rename ${task.title}`}
                onDelete={() => {
                  setConfirmDeleteId(task.id);
                }}
                deleteLabel={`Delete ${task.title}`}
              />
            ),
          )}
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
