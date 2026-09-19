import type {
  ClientDataSchemas,
  ClientMetadataSchema,
} from "@anvia/client";

const MAX_METADATA_STRING = 200;
const MAX_ACTIVITY_ID = 200;
const MAX_ACTIVITY_LABEL = 240;
const MAX_RESEARCH_MESSAGE = 4_000;
const MAX_ACTIVITIES = 50;
const MAX_RETRIEVAL_COUNT = 100_000;

export type ChatStreamMetadata = {
  sessionId: string;
  modelId: string;
  reasoningEffort: string | null;
};

export type DeepResearchProgress = {
  phase: "planning" | "researching" | "synthesizing" | "completed" | "failed";
  message: string;
  activities?: readonly {
    id: string;
    kind: "planning" | "retrieval" | "analysis" | "verification" | "synthesis";
    label: string;
    status: "active" | "done" | "failed";
  }[];
  stats?: {
    retrievalCalls: number;
    retrievalLimit: number;
  };
};

export type QueuedMessageApplied = {
  clientMessageId: string;
  attachmentCount: number;
};

export type ToolWaitProgress = {
  toolCallId: string;
  toolName: string;
  phase: "running" | "wait_elapsed" | "awaiting" | "cancelled" | "completed" | "failed";
  elapsedMs: number;
  waitCount: number;
  stage?: string;
};

export type ChatDataMap = {
  deepResearchProgress: DeepResearchProgress;
  queuedMessageApplied: QueuedMessageApplied;
  toolWaitProgress: ToolWaitProgress;
};

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error?: { message: string } };

type Schema<T> = {
  safeParse(value: unknown): ParseResult<T>;
};

function success<T>(data: T): ParseResult<T> {
  return { success: true, data };
}

/** Never include the rejected value in a browser-visible protocol error. */
function failure<T>(message: string): ParseResult<T> {
  return { success: false, error: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function boundedCount(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

const streamMetadataSchema: Schema<ChatStreamMetadata> = {
  safeParse(value) {
    if (!isRecord(value) || !exactKeys(value, ["sessionId", "modelId", "reasoningEffort"])) {
      return failure("invalid stream metadata");
    }
    if (!boundedString(value.sessionId, MAX_METADATA_STRING)) {
      return failure("invalid stream metadata");
    }
    if (!boundedString(value.modelId, MAX_METADATA_STRING)) {
      return failure("invalid stream metadata");
    }
    if (
      value.reasoningEffort !== null &&
      !boundedString(value.reasoningEffort, 40)
    ) {
      return failure("invalid stream metadata");
    }
    return success({
      sessionId: value.sessionId,
      modelId: value.modelId,
      reasoningEffort: value.reasoningEffort,
    });
  },
};

function parseDeepResearchProgress(value: unknown): ParseResult<DeepResearchProgress> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["phase", "message", "activities", "stats"]) ||
    !["planning", "researching", "synthesizing", "completed", "failed"].includes(
      value.phase as string,
    ) ||
    !boundedString(value.message, MAX_RESEARCH_MESSAGE)
  ) {
    return failure("invalid deep research progress");
  }

  let activities: DeepResearchProgress["activities"];
  if (has(value, "activities")) {
    if (!Array.isArray(value.activities) || value.activities.length > MAX_ACTIVITIES) {
      return failure("invalid deep research progress");
    }
    const parsedActivities: NonNullable<DeepResearchProgress["activities"]>[number][] = [];
    for (const item of value.activities) {
      if (
        !isRecord(item) ||
        !exactKeys(item, ["id", "kind", "label", "status"]) ||
        !boundedString(item.id, MAX_ACTIVITY_ID) ||
        !boundedString(item.label, MAX_ACTIVITY_LABEL) ||
        !["planning", "retrieval", "analysis", "verification", "synthesis"].includes(
          item.kind as string,
        ) ||
        !["active", "done", "failed"].includes(item.status as string)
      ) {
        return failure("invalid deep research progress");
      }
      parsedActivities.push({
        id: item.id,
        kind: item.kind as NonNullable<DeepResearchProgress["activities"]>[number]["kind"],
        label: item.label,
        status: item.status as NonNullable<DeepResearchProgress["activities"]>[number]["status"],
      });
    }
    activities = parsedActivities;
  }

  let stats: DeepResearchProgress["stats"];
  if (has(value, "stats")) {
    if (
      !isRecord(value.stats) ||
      !exactKeys(value.stats, ["retrievalCalls", "retrievalLimit"]) ||
      !boundedCount(value.stats.retrievalCalls, MAX_RETRIEVAL_COUNT) ||
      !boundedCount(value.stats.retrievalLimit, MAX_RETRIEVAL_COUNT) ||
      value.stats.retrievalCalls > value.stats.retrievalLimit
    ) {
      return failure("invalid deep research progress");
    }
    stats = {
      retrievalCalls: value.stats.retrievalCalls,
      retrievalLimit: value.stats.retrievalLimit,
    };
  }

  return success({
    phase: value.phase as DeepResearchProgress["phase"],
    message: value.message,
    ...(activities === undefined ? {} : { activities }),
    ...(stats === undefined ? {} : { stats }),
  });
}

const TOOL_WAIT_PHASES = [
  "running",
  "wait_elapsed",
  "awaiting",
  "cancelled",
  "completed",
  "failed",
] as const;

function parseToolWaitProgress(value: unknown): ParseResult<ToolWaitProgress> {
  if (!isRecord(value)) return failure("invalid tool wait progress");
  const hasStage = has(value, "stage");
  const keys = hasStage
    ? ["toolCallId", "toolName", "phase", "elapsedMs", "waitCount", "stage"]
    : ["toolCallId", "toolName", "phase", "elapsedMs", "waitCount"];
  if (
    !exactKeys(value, keys) ||
    !boundedString(value.toolCallId, MAX_METADATA_STRING) ||
    !boundedString(value.toolName, MAX_METADATA_STRING) ||
    !TOOL_WAIT_PHASES.includes(value.phase as ToolWaitProgress["phase"]) ||
    !boundedCount(value.elapsedMs, 86_400_000) ||
    !boundedCount(value.waitCount, 10_000)
  ) {
    return failure("invalid tool wait progress");
  }
  if (hasStage && !boundedString(value.stage, MAX_ACTIVITY_LABEL)) {
    return failure("invalid tool wait progress");
  }
  return success({
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    phase: value.phase as ToolWaitProgress["phase"],
    elapsedMs: value.elapsedMs,
    waitCount: value.waitCount,
    ...(hasStage ? { stage: value.stage as string } : {}),
  });
}

function parseQueuedMessageApplied(value: unknown): ParseResult<QueuedMessageApplied> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["clientMessageId", "attachmentCount"]) ||
    !boundedString(value.clientMessageId, MAX_METADATA_STRING) ||
    !boundedCount(value.attachmentCount, 100)
  ) {
    return failure("invalid queued message acknowledgement");
  }
  return success({
    clientMessageId: value.clientMessageId,
    attachmentCount: value.attachmentCount,
  });
}

const deepResearchProgressSchema: Schema<DeepResearchProgress> = {
  safeParse: parseDeepResearchProgress,
};
const queuedMessageAppliedSchema: Schema<QueuedMessageApplied> = {
  safeParse: parseQueuedMessageApplied,
};
const toolWaitProgressSchema: Schema<ToolWaitProgress> = {
  safeParse: parseToolWaitProgress,
};

export const ChatStreamMetadataSchema: ClientMetadataSchema<ChatStreamMetadata> =
  streamMetadataSchema;

export const ChatDataSchemas = {
  deepResearchProgress: deepResearchProgressSchema,
  queuedMessageApplied: queuedMessageAppliedSchema,
  toolWaitProgress: toolWaitProgressSchema,
} satisfies ClientDataSchemas<ChatDataMap>;
