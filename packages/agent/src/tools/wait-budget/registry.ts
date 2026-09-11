import {
  AWAIT_TOOL_CALL_NAME,
  CANCEL_TOOL_CALL_NAME,
  CANCELLED_STATUS,
  STILL_RUNNING_STATUS,
  type CancelledToolResult,
  type InFlightToolStatus,
  type ObserveResult,
  type StillRunningResult,
} from "./types.js";
import { MAX_JOB_WALL_MS } from "./limits.js";

export class ToolCallCancelledError extends Error {
  readonly code = "TOOL_CALL_CANCELLED";
  readonly toolCallId: string;

  constructor(toolCallId: string) {
    super(`Tool call ${toolCallId} was cancelled.`);
    this.name = "ToolCallCancelledError";
    this.toolCallId = toolCallId;
  }
}

export class ToolCallUnknownError extends Error {
  readonly code = "TOOL_CALL_UNKNOWN";
  readonly toolCallId: string;

  constructor(toolCallId: string) {
    super(`No in-flight tool call "${toolCallId}".`);
    this.name = "ToolCallUnknownError";
    this.toolCallId = toolCallId;
  }
}

type Job = {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  waitCount: number;
  status: InFlightToolStatus;
  abort: AbortController;
  promise: Promise<unknown>;
  output?: unknown;
  error?: unknown;
  stage?: string;
  lastObservedStage?: string;
};

export type RegisterAndWaitInput = {
  toolCallId: string;
  toolName: string;
  parentSignal?: AbortSignal;
  sliceMs: number;
  work: (signal: AbortSignal) => Promise<unknown>;
};

export type InFlightToolRegistryOptions = {
  now?: () => number;
  maxWallMs?: number;
};

function stillRunningPayload(job: Job, now: number, progressMoved: boolean): StillRunningResult {
  const payload: StillRunningResult = {
    status: STILL_RUNNING_STATUS,
    toolCallId: job.toolCallId,
    toolName: job.toolName,
    elapsedMs: Math.max(0, now - job.startedAt),
    waitCount: job.waitCount,
    progressMoved,
    mustInformUser: true,
    next: [AWAIT_TOOL_CALL_NAME, CANCEL_TOOL_CALL_NAME],
  };
  if (job.stage !== undefined) payload.stage = job.stage;
  return payload;
}

function cancelledPayload(job: Job, now: number): CancelledToolResult {
  const payload: CancelledToolResult = {
    status: CANCELLED_STATUS,
    toolCallId: job.toolCallId,
    toolName: job.toolName,
    elapsedMs: Math.max(0, now - job.startedAt),
  };
  if (job.stage !== undefined) payload.stage = job.stage;
  return payload;
}

export class InFlightToolRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => number;
  private readonly maxWallMs: number;

  constructor(options: InFlightToolRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxWallMs = options.maxWallMs ?? MAX_JOB_WALL_MS;
  }

  hasRunning(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === "running") return true;
    }
    return false;
  }

  getStatus(toolCallId: string): InFlightToolStatus | undefined {
    return this.jobs.get(toolCallId)?.status;
  }

  peek(toolCallId: string): { toolName: string; status: InFlightToolStatus; stage?: string } | undefined {
    const job = this.jobs.get(toolCallId);
    if (!job) return undefined;
    const view: { toolName: string; status: InFlightToolStatus; stage?: string } = {
      toolName: job.toolName,
      status: job.status,
    };
    if (job.stage !== undefined) view.stage = job.stage;
    return view;
  }

  setStage(toolCallId: string, stage: string): void {
    const job = this.jobs.get(toolCallId);
    if (!job || job.status !== "running") return;
    job.stage = stage;
  }

  async registerAndWait(input: RegisterAndWaitInput): Promise<ObserveResult> {
    if (this.jobs.has(input.toolCallId)) {
      throw new Error(`Tool call "${input.toolCallId}" is already registered.`);
    }
    const abort = new AbortController();
    const unlinkParent = linkAbort(input.parentSignal, abort);
    const job: Job = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      startedAt: this.now(),
      waitCount: 0,
      status: "running",
      abort,
      promise: Promise.resolve(),
    };
    job.promise = Promise.resolve()
      .then(() => input.work(abort.signal))
      .then(
        (output) => {
          unlinkParent();
          if (job.status === "cancelled") return output;
          job.status = "completed";
          job.output = output;
          return output;
        },
        (error: unknown) => {
          unlinkParent();
          if (job.status === "cancelled") throw error;
          job.status = abort.signal.aborted ? "cancelled" : "failed";
          job.error = error;
          throw error;
        },
      );
    this.jobs.set(input.toolCallId, job);
    return this.waitSlice(job, input.sliceMs);
  }

  async awaitSlice(toolCallId: string, sliceMs: number): Promise<ObserveResult> {
    const job = this.jobs.get(toolCallId);
    if (!job) throw new ToolCallUnknownError(toolCallId);
    return this.waitSlice(job, sliceMs);
  }

  cancel(toolCallId: string): CancelledToolResult {
    const job = this.jobs.get(toolCallId);
    if (!job) throw new ToolCallUnknownError(toolCallId);
    if (job.status === "running") {
      job.status = "cancelled";
      const error = new ToolCallCancelledError(toolCallId);
      job.error = error;
      job.abort.abort(error);
    }
    return cancelledPayload(job, this.now());
  }

  abortAll(reason: string): void {
    const error = new ToolCallCancelledError(reason);
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "cancelled";
      job.error = error;
      job.abort.abort(error);
    }
  }

  private async waitSlice(job: Job, sliceMs: number): Promise<ObserveResult> {
    if (job.status === "completed") return { kind: "settled", output: job.output };
    if (job.status === "cancelled") {
      return { kind: "cancelled", payload: cancelledPayload(job, this.now()) };
    }
    if (job.status === "failed") return { kind: "failed", error: job.error };

    const elapsed = this.now() - job.startedAt;
    if (elapsed >= this.maxWallMs) {
      const error = new Error(
        `Tool call ${job.toolCallId} exceeded its ${this.maxWallMs}ms wall-clock budget.`,
      );
      error.name = "TimeoutError";
      job.status = "failed";
      job.error = error;
      job.abort.abort(error);
      return { kind: "failed", error };
    }

    const remainingWall = this.maxWallMs - elapsed;
    const budget = Math.max(1, Math.min(sliceMs, remainingWall));
    const stageBefore = job.stage;
    const raced = await raceSettled(job.promise, budget);
    if (raced === "timeout") {
      job.waitCount += 1;
      const progressMoved = job.stage !== undefined && job.stage !== job.lastObservedStage;
      if (job.stage !== undefined) job.lastObservedStage = job.stage;
      return {
        kind: "still_running",
        payload: stillRunningPayload(job, this.now(), progressMoved && stageBefore !== undefined),
      };
    }
    return this.settleJob(job);
  }

  private settleJob(job: Job): ObserveResult {
    switch (job.status) {
      case "cancelled":
        return { kind: "cancelled", payload: cancelledPayload(job, this.now()) };
      case "failed":
        return { kind: "failed", error: job.error };
      case "completed":
        return { kind: "settled", output: job.output };
      case "running":
        return { kind: "settled", output: job.output };
    }
  }
}

function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => undefined;
  if (parent.aborted) {
    child.abort(parent.reason ?? new Error("aborted"));
    return () => undefined;
  }
  const onAbort = () => child.abort(parent.reason ?? new Error("aborted"));
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

function raceSettled(promise: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: "done" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), ms);
    promise.then(
      () => finish("done"),
      () => finish("done"),
    );
  });
}
