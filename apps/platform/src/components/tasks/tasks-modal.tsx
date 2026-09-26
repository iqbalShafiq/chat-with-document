import { useState } from "react";
import { DialogShell } from "#/components/ui/dialog-shell";
import { SegmentedTabs } from "#/components/ui/segmented-tabs";
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
      <SegmentedTabs
        label="Tasks and schedules"
        value={tab}
        onSelect={setTab}
        options={[
          { value: "tasks", label: "Tasks" },
          { value: "schedules", label: "Schedules" },
        ]}
      />
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
