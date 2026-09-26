import { useCallback, useEffect, useState } from "react";
import {
  cancelSchedule,
  listSchedules,
  type WorkspaceSchedule,
} from "#/lib/api-artifacts";

/**
 * Right-rail schedules panel. Custom row (not ManagementRow): schedules
 * have no toggle semantics — only active/cancelled status plus cancel.
 */
export function SchedulesPanel({ sessionId }: { sessionId: string }) {
  const [schedules, setSchedules] = useState<WorkspaceSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    void listSchedules(sessionId)
      .then(setSchedules)
      .catch((fetchError) => {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load schedules");
      });
  }, [sessionId]);

  const mutate = useCallback(
    (work: Promise<unknown>) => {
      void work
        .then(() => {
          setError(null);
          refresh();
        })
        .catch((mutationError) => {
          setError(mutationError instanceof Error ? mutationError.message : "Cancel failed");
        });
    },
    [refresh],
  );

  useEffect(() => {
    setSchedules(null);
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
  if (schedules === null) {
    return (
      <div className="flex flex-col gap-1.5" aria-label="Loading schedules">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton-shimmer h-10 rounded-xl" />
        ))}
      </div>
    );
  }
  if (schedules.length === 0) {
    return (
      <p className="text-[11px] text-text-faint">
        No schedules yet — ask the agent to remind you (once, daily, or weekly).
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Schedules">
      {schedules.map((schedule) => {
        const active = schedule.status === "active";
        return (
          <li
            key={schedule.id}
            className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{schedule.title}</p>
              <p className="truncate text-[11px] text-text-faint">
                {schedule.freq}
                {schedule.nextRunAt ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}` : ""}
                {` · ${schedule.status}`}
              </p>
            </div>
            {active ? (
              <button
                type="button"
                aria-label={`Cancel ${schedule.title}`}
                onClick={() => {
                  mutate(cancelSchedule(schedule.id, sessionId));
                }}
                className="h-7 shrink-0 cursor-pointer rounded-lg border border-white/[0.08] px-2.5 text-[11px] text-text-muted transition hover:bg-white/10 hover:text-text active:scale-95"
              >
                Cancel
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
