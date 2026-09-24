import { useState } from "react";
import { DialogShell } from "#/components/ui/dialog-shell";
import { TasksPanel } from "#/components/tasks/tasks-panel";
import { SchedulesPanel } from "#/components/tasks/schedules-panel";

/**
 * Sidebar tasks entry: tabbed Tasks + Schedules, scoped to the active
 * session (same scope rule as the agent). Outside a chat, shows a hint.
 */
export function TasksModal({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  const [tab, setTab] = useState<"tasks" | "schedules">("tasks");
  if (!open) return null;
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Tasks"
      description="Shared checklist between you and the agent in this scope."
      size="lg"
      heightMode="viewport"
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <div className="chat-scroll-bleed absolute inset-0 overflow-y-auto overscroll-contain p-4">
          <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Tasks and schedules" className="flex gap-1.5">
        {(["tasks", "schedules"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "inline-flex h-7 items-center rounded-lg border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium capitalize text-accent"
                : "inline-flex h-7 items-center rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium capitalize text-text-muted hover:text-text"
            }
          >
            {t}
          </button>
        ))}
      </div>
      {sessionId ? (
        tab === "tasks" ? (
          <TasksPanel sessionId={sessionId} />
        ) : (
          <SchedulesPanel sessionId={sessionId} />
        )
      ) : (
        <p className="text-[12px] text-text-muted">
          Open a chat first — tasks live in the active session scope.
        </p>
      )}
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
