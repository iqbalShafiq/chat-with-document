import {
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  Loader2,
} from "lucide-react";
import { useId, useState } from "react";
import {
  deepResearchActivityStatusLabel,
  deepResearchPhaseLabel,
  type DeepResearchActivity,
  type DeepResearchActivityState,
} from "#/lib/chat/deep-research-activity";

function ActivityIcon({ activity }: { activity: DeepResearchActivity }) {
  if (activity.status === "done") {
    return <Check className="size-3.5 text-accent" strokeWidth={2.25} />;
  }
  if (activity.status === "failed") {
    return <CircleAlert className="size-3.5 text-danger" strokeWidth={2} />;
  }
  return (
    <Loader2
      className="size-3.5 animate-spin text-accent motion-reduce:animate-none"
      strokeWidth={2}
    />
  );
}

function phaseTone(phase: DeepResearchActivityState["phase"]): string {
  return phase === "failed" ? "text-danger/90" : "text-accent";
}

export function DeepResearchActivityPanel({
  state,
}: {
  state: DeepResearchActivityState;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const isFailed = state.phase === "failed";
  const hasRetrievalBudget = state.retrievalLimit > 0;
  const counter = hasRetrievalBudget
    ? `${state.retrievalCalls}/${state.retrievalLimit} retrievals`
    : null;

  return (
    <section
      data-deep-research-activity
      data-deep-research-phase={state.phase}
      className={`glass rounded-xl border px-3 py-2.5 animate-fade-in ${
        isFailed
          ? "border-danger/25 bg-danger-soft/40"
          : "border-accent/20 bg-accent/[0.04]"
      }`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] ${phaseTone(state.phase)}`}
          aria-hidden="true"
        >
          {isFailed ? (
            <CircleAlert className="size-3.5" strokeWidth={2} />
          ) : state.phase === "completed" ? (
            <Check className="size-3.5" strokeWidth={2.25} />
          ) : (
            <Circle className="size-3.5" strokeWidth={2} />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className={`min-w-0 truncate text-[11px] font-semibold ${phaseTone(state.phase)}`}>
              Deep Research · {deepResearchPhaseLabel(state.phase)}
            </p>
            {counter ? (
              <span className="shrink-0 text-[10px] font-medium text-text-faint">
                {counter}
              </span>
            ) : null}
          </div>
          <p
            role="status"
            aria-live="polite"
            className={`mt-0.5 truncate text-[11px] ${
              isFailed ? "text-danger/80" : "text-text-muted"
            }`}
            title={state.message}
          >
            {state.message}
          </p>
        </div>

        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-[10px] font-medium text-text-muted transition duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <span>{open ? "Hide activity" : "View activity"}</span>
          {state.activities.length > 0 ? (
            <span className="text-text-faint">({state.activities.length})</span>
          ) : null}
          <ChevronDown
            className={`size-3 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
            strokeWidth={2}
          />
        </button>
      </div>

      <div
        id={panelId}
        hidden={!open}
        className="mt-2.5 border-l border-white/[0.1] pl-3 animate-fade-in motion-reduce:animate-none"
      >
          {state.activities.length > 0 ? (
            <ol
              className="chat-scroll max-h-[9.5rem] space-y-2 overflow-y-auto overscroll-contain pr-1"
              aria-label="Research activity"
              data-deep-research-activity-scroll
            >
              {state.activities.map((activity) => (
                <li
                  key={activity.id}
                  data-deep-research-activity-item
                  className="flex min-w-0 items-start gap-2"
                >
                  <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
                    <ActivityIcon activity={activity} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-text/90">
                      {activity.label}
                    </span>
                    <span
                      className={`block text-[10px] ${
                        activity.status === "failed"
                          ? "text-danger/75"
                          : "text-text-faint"
                      }`}
                    >
                      {deepResearchActivityStatusLabel(activity.status)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[11px] text-text-faint">
              Activity details will appear as the research progresses.
            </p>
          )}
      </div>
    </section>
  );
}
