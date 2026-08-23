export type DeepResearchActivityPhase =
  | "idle"
  | "planning"
  | "researching"
  | "synthesizing"
  | "completed"
  | "failed";

export type DeepResearchActivityKind =
  | "planning"
  | "retrieval"
  | "analysis"
  | "verification"
  | "synthesis";

export type DeepResearchActivityStatus = "active" | "done" | "failed";

export type DeepResearchActivity = {
  id: string;
  kind: DeepResearchActivityKind;
  label: string;
  status: DeepResearchActivityStatus;
};

export type DeepResearchProgressEvent = {
  phase: Exclude<DeepResearchActivityPhase, "idle">;
  message: string;
  activities?: DeepResearchActivity[];
  stats?: {
    retrievalCalls: number;
    retrievalLimit: number;
  };
};

export type DeepResearchActivityState = {
  phase: DeepResearchActivityPhase;
  message: string;
  activities: DeepResearchActivity[];
  retrievalCalls: number;
  retrievalLimit: number;
};

const MAX_VISIBLE_ACTIVITIES = 12;
const PHASES = new Set<DeepResearchActivityPhase>([
  "planning",
  "researching",
  "synthesizing",
  "completed",
  "failed",
]);
const ACTIVITY_KINDS = new Set<DeepResearchActivityKind>([
  "planning",
  "retrieval",
  "analysis",
  "verification",
  "synthesis",
]);
const ACTIVITY_STATUSES = new Set<DeepResearchActivityStatus>([
  "active",
  "done",
  "failed",
]);
const SAFE_ACTIVITY_LABELS = new Set([
  "Finding relevant documents",
  "Searching document pages",
  "Reading another document page",
  "Inspecting document pages",
  "Extracting document tables",
  "Searching the web",
  "Reading a web page",
  "Reading the dataset",
  "Analyzing the dataset",
  "Querying the dataset",
  "Computing descriptive statistics",
  "Computing correlation",
  "Fitting regression",
  "Planning the research",
  "Checking evidence and citations",
  "Preparing the final report",
  "Completing the research",
]);
const SAFE_PHASE_MESSAGES: Record<
  Exclude<DeepResearchActivityPhase, "idle">,
  string
> = {
  planning: "Planning the research",
  researching: "Searching and analyzing the available evidence",
  synthesizing: "Checking evidence and citations",
  completed: "Deep Research report is ready",
  failed: "Deep Research could not complete",
};

export const initialDeepResearchActivityState: DeepResearchActivityState = {
  phase: "idle",
  message: "",
  activities: [],
  retrievalCalls: 0,
  retrievalLimit: 0,
};

export function deepResearchPhaseLabel(
  phase: DeepResearchActivityPhase,
): string {
  switch (phase) {
    case "planning":
      return "Planning research";
    case "researching":
      return "Researching sources";
    case "synthesizing":
      return "Preparing the report";
    case "completed":
      return "Research complete";
    case "failed":
      return "Research stopped";
    case "idle":
      return "Research idle";
  }
}

export function deepResearchActivityStatusLabel(
  status: DeepResearchActivityStatus,
): string {
  switch (status) {
    case "active":
      return "In progress";
    case "done":
      return "Done";
    case "failed":
      return "Could not complete";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function parseActivity(value: unknown): DeepResearchActivity | null {
  if (!isRecord(value)) return null;
  const { id, kind, label, status } = value;
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 80 ||
    !/^[a-z0-9-]+$/i.test(id) ||
    typeof kind !== "string" ||
    !ACTIVITY_KINDS.has(kind as DeepResearchActivityKind) ||
    typeof label !== "string" ||
    !SAFE_ACTIVITY_LABELS.has(label.trim()) ||
    typeof status !== "string" ||
    !ACTIVITY_STATUSES.has(status as DeepResearchActivityStatus)
  ) {
    return null;
  }
  return {
    id,
    kind: kind as DeepResearchActivityKind,
    label: label.trim(),
    status: status as DeepResearchActivityStatus,
  };
}

function parseActivities(value: unknown): DeepResearchActivity[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseActivity).filter((activity): activity is DeepResearchActivity => activity !== null);
}

export function resetDeepResearchActivity(): DeepResearchActivityState {
  return {
    phase: "idle",
    message: "",
    activities: [],
    retrievalCalls: 0,
    retrievalLimit: 0,
  };
}

export function reduceDeepResearchProgress(
  state: DeepResearchActivityState,
  event: unknown,
): DeepResearchActivityState {
  if (!isRecord(event)) return state;

  const phase = event.phase;
  if (typeof phase !== "string" || !PHASES.has(phase as DeepResearchActivityPhase)) {
    return state;
  }

  const isNewRun = phase === "planning" && state.phase !== "planning";
  const nextActivities = isNewRun ? [] : [...state.activities];
  const parsedActivities = parseActivities(event.activities);
  for (const activity of parsedActivities) {
    const existingIndex = nextActivities.findIndex((item) => item.id === activity.id);
    if (existingIndex >= 0) {
      nextActivities[existingIndex] = activity;
    } else {
      nextActivities.push(activity);
    }
  }
  const visibleActivities = nextActivities.slice(-MAX_VISIBLE_ACTIVITIES);
  const stats = isRecord(event.stats) ? event.stats : null;
  const candidateRetrievalLimit = stats
    ? finiteNonNegativeInteger(
        stats.retrievalLimit,
        isNewRun ? 0 : state.retrievalLimit,
      )
    : isNewRun
      ? 0
      : state.retrievalLimit;
  const retrievalLimit = isNewRun
    ? candidateRetrievalLimit
    : Math.max(state.retrievalLimit, candidateRetrievalLimit);
  const candidateRetrievalCalls = stats
    ? finiteNonNegativeInteger(
        stats.retrievalCalls,
        isNewRun ? 0 : state.retrievalCalls,
      )
    : isNewRun
      ? 0
      : state.retrievalCalls;
  const retrievalCalls = retrievalLimit > 0
    ? Math.min(
        retrievalLimit,
        Math.max(isNewRun ? 0 : state.retrievalCalls, candidateRetrievalCalls),
      )
    : 0;

  return {
    phase: phase as DeepResearchActivityPhase,
    message: safeProgressMessage(
      phase as Exclude<DeepResearchActivityPhase, "idle">,
      parsedActivities,
    ),
    activities: visibleActivities,
    retrievalCalls,
    retrievalLimit,
  };
}

function safeProgressMessage(
  phase: Exclude<DeepResearchActivityPhase, "idle">,
  activities: DeepResearchActivity[],
): string {
  if (phase === "researching") {
    const current = [...activities]
      .reverse()
      .find((activity) => activity.kind !== "planning");
    if (current) {
      const suffix =
        current.status === "active"
          ? "…"
          : current.status === "done"
            ? " complete"
            : " failed";
      return `${current.label}${suffix}`;
    }
  }
  return SAFE_PHASE_MESSAGES[phase];
}
