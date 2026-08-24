import type { Job } from "bullmq";
import { randomUUID } from "node:crypto";
import type {
  AgentInteractionOutcome,
  AgentStream,
  AgentStreamEvent,
} from "@anvia/core/agent";
import {
  parseAgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type { Message, UserMessage } from "@anvia/core/completion";
import type { AgentRunOptions } from "@anvia/core/agent";
import {
  getStreamStore,
  type ResumableStreamStoreWithMeta,
} from "../../lib/resumable-stream-store.js";
import { getContext7McpServer } from "../../lib/context7-server.js";
import { prisma } from "../../utils/prisma.js";
import { reconstructChatRunInput } from "./build-run-input.js";
import {
  createChatClientStream,
  toChatResumableEvent,
  type ChatAppEvent,
  type ChatClientEvent,
  type ChatResumableEvent,
  type ChatStreamEvent,
} from "./client-events.js";
import {
  getInteractionStore,
  type InteractionStore,
} from "./interaction-store.js";
import { getApprovalRegistry } from "./approval-registry.js";
import {
  claimInteractionPolicy,
  consumeInteractionPolicy,
  interactionResponseFingerprint,
  releaseInteractionPolicy,
  InteractionPolicyStoreError,
  type InteractionPolicyClaimInput,
  type InteractionPolicyClaimResult,
} from "./interaction-policy-store.js";
import {
  parseChatRunJobData,
  releaseActiveRun,
  type ChatRunJobData,
  type ResumeRunJob,
  type StartRunJob,
} from "./run-queue.js";
import {
  getSteeringStore,
  SteeringPump,
  type SteeringStore,
} from "./steering.js";
import { removeFailedPromptForRetry } from "./remove-failed-prompt.js";

export { CHAT_RUN_QUEUE, type ChatRunJobData } from "./run-queue.js";

const SAFE_ERROR_MESSAGE = "Something went wrong while answering. Send again.";
const SAFE_CANCEL_MESSAGE = "The answer was stopped.";
const STOP_POLL_MS = 150;

type WorkerStreamStore = Pick<ResumableStreamStoreWithMeta, "status" | "close"> & {
  append(input: { streamId: string; event: ChatResumableEvent }): Promise<unknown>;
};

export type InteractionPolicyClaim = {
  input: InteractionPolicyClaimInput;
  result: InteractionPolicyClaimResult;
};

export type ApprovalPolicyRegistry = Pick<
  ReturnType<typeof getApprovalRegistry>,
  // setToolOverride/revokeToolGrant remain in the injected shape only so
  // tests can prove the worker never invokes the legacy global mutation.
  "grantTool" | "hasToolGrant" | "revokeToolGrant" | "setToolOverride" | "takeToolOverride"
>;

export type ChatRunWorkerDependencies = {
  streamStore?: WorkerStreamStore;
  reconstruct?: typeof reconstructChatRunInput;
  getContext7Server?: typeof getContext7McpServer;
  interactionStore?: Pick<InteractionStore, "onInteraction">;
  claimInteractionPolicy?: (
    input: InteractionPolicyClaimInput,
  ) => Promise<InteractionPolicyClaimResult | null>;
  consumeInteractionPolicy?: (input: InteractionPolicyClaimInput) => Promise<void>;
  releaseInteractionPolicy?: (input: Pick<InteractionPolicyClaimInput, "interactionId" | "claimToken">) => Promise<void>;
  approvalRegistry?: ApprovalPolicyRegistry;
  steeringStore?: SteeringStore;
  isStopRequested?: (streamId: string) => Promise<boolean>;
  clearStopFlag?: (streamId: string) => Promise<void>;
  releaseActiveRun?: typeof releaseActiveRun;
  sessionExists?: (sessionId: string, userId: string) => Promise<boolean>;
  removeFailedPromptRow?: (input: {
    sessionId: string;
    userId: string;
    clientMessageId: string;
  }) => Promise<void>;
  persistInteraction?: (input: {
    outcome: AgentInteractionOutcome;
    recipe: StartRunJob["recipe"];
    sourceStreamId: string;
    userId: string;
    sessionId: string;
  }) => Promise<void>;
  onSteeringApplied?: (message: {
    clientMessageId: string;
    text: string;
    attachments?: readonly unknown[];
  }) => Promise<void>;
  activeRuns?: ActiveRunRegistry;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUserPrompt(message: Message): UserMessage {
  if (message.role !== "user") throw new Error("start prompt must be a user message");
  return message;
}

function safeErrorEvent(error?: unknown): AgentStreamEvent {
  const cancellation = isRecord(error) && error.code === "CHAT_RUN_CANCELLED";
  return {
    type: "error",
    error: {
      code: cancellation ? "CHAT_RUN_CANCELLED" : "CHAT_RUN_FAILED",
      message: cancellation ? SAFE_CANCEL_MESSAGE : SAFE_ERROR_MESSAGE,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  } as AgentStreamEvent;
}

function safeError(error: unknown): Error {
  const cancellation = isRecord(error) && error.code === "CHAT_RUN_CANCELLED";
  const result = new Error(cancellation ? SAFE_CANCEL_MESSAGE : SAFE_ERROR_MESSAGE);
  result.name = cancellation ? "ChatRunCancelledError" : "ChatRunError";
  Object.assign(result, {
    code: cancellation ? "CHAT_RUN_CANCELLED" : "CHAT_RUN_FAILED",
  });
  return result;
}

function isTransientModelNotFoundError(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "error") return false;
  const raw = event.error;
  const message = raw instanceof Error
    ? raw.message
    : isRecord(raw) && typeof raw.message === "string"
      ? raw.message
      : typeof raw === "string" ? raw : "";
  // This recognises only the provider's bounded error shape, not arbitrary
  // model/tool/user text. Model id is never included in the diagnostic.
  return /^the requested model ['"][^'"]{1,200}['"] does not exist$/i.test(message.trim()) ||
    /^model ['"][^'"]{1,200}['"] does not exist$/i.test(message.trim());
}

function hasVisibleRawEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  return ![
    "run_start",
    "turn_start",
    "generation_start",
    "steering_applied",
    "guardrail_decision",
    "memory_compaction",
  ].includes(String(event.type));
}

function isRootTerminal(
  event: unknown,
): event is Extract<AgentStreamEvent, { type: "response" | "interaction" | "blocked" | "error" }> {
  if (!isRecord(event)) return false;
  return event.type === "response" || event.type === "interaction" || event.type === "blocked" || event.type === "error";
}

function nativeErrorNeedsSanitization(
  event: unknown,
): event is Extract<AgentStreamEvent, { type: "error" }> {
  return isRecord(event) && event.type === "error";
}

function sanitizeNativeEvent(event: AgentStreamEvent): AgentStreamEvent {
  if (!nativeErrorNeedsSanitization(event)) return event;
  return safeErrorEvent(event.error);
}

type PreparedAttempt =
  | { kind: "retry"; stream: AgentStream }
  | { kind: "ready"; stream: AgentStream; events: AsyncIterable<AgentStreamEvent> };

/**
 * Buffers only the non-visible prefix of an attempt so a transient provider
 * error cannot first publish a client run_start/error pair and then retry.
 */
async function prepareAttempt(
  stream: AgentStream,
  attempt: number,
): Promise<PreparedAttempt> {
  const iterator = stream.events[Symbol.asyncIterator]();
  const buffered: AgentStreamEvent[] = [];
  const ready = (): PreparedAttempt => ({
    kind: "ready",
    stream,
    events: (async function* () {
      for (const item of buffered) yield item;
      for (;;) {
        const rest = await iterator.next();
        if (rest.done) return;
        yield rest.value;
      }
    })(),
  });
  let visible = false;
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return ready();
    }
    const event = next.value;
    // A model-not-found error is the one provider failure eligible for the
    // pre-output retry. Inspect it before marking the error itself visible;
    // otherwise the retry gate is defeated by the terminal error event.
    if (event.type === "error" && !visible && attempt === 0 && isTransientModelNotFoundError(event)) {
      stream.cancel("transient model error");
      return { kind: "retry", stream };
    }
    if (hasVisibleRawEvent(event)) visible = true;
    buffered.push(event);
    // Once a client-visible event is buffered, the retry decision is no
    // longer legal. Hand the same iterator to the normal adapter immediately
    // so streaming output and live steering are not held until root terminal.
    if (visible || isRootTerminal(event)) return ready();
  }
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.ended) return { value: undefined as never, done: true };
    return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
  }

  drain(): T[] {
    const values = this.values;
    this.values = [];
    return values;
  }
}

export type ActiveRunHandle = {
  cancel(reason: string): void;
  done: Promise<void>;
};

export class ActiveRunRegistry {
  private readonly active = new Map<string, ActiveRunHandle>();
  private accepting = true;

  get isAccepting(): boolean { return this.accepting; }

  stopAccepting(): void { this.accepting = false; }

  register(streamId: string, handle: ActiveRunHandle): () => void {
    if (!this.accepting) throw new Error("chat worker is shutting down");
    this.active.set(streamId, handle);
    return () => {
      if (this.active.get(streamId) === handle) this.active.delete(streamId);
    };
  }

  async cancelAll(reason = "worker shutdown"): Promise<void> {
    this.accepting = false;
    const handles = [...this.active.values()];
    for (const handle of handles) handle.cancel(reason);
    await Promise.allSettled(handles.map((handle) => handle.done));
  }
}

let activeRunRegistry: ActiveRunRegistry | null = null;

export function getActiveRunRegistry(): ActiveRunRegistry {
  activeRunRegistry ??= new ActiveRunRegistry();
  return activeRunRegistry;
}

function createDefaultDependencies(): Required<Pick<
  ChatRunWorkerDependencies,
  | "streamStore"
  | "reconstruct"
  | "getContext7Server"
  | "interactionStore"
  | "claimInteractionPolicy"
  | "consumeInteractionPolicy"
  | "releaseInteractionPolicy"
  | "approvalRegistry"
  | "steeringStore"
  | "isStopRequested"
  | "clearStopFlag"
  | "releaseActiveRun"
  | "sessionExists"
  | "removeFailedPromptRow"
  | "activeRuns"
>> & ChatRunWorkerDependencies {
  const streamStore = getStreamStore();
  return {
    streamStore,
    reconstruct: reconstructChatRunInput,
    getContext7Server: getContext7McpServer,
    interactionStore: getInteractionStore(),
    claimInteractionPolicy: async (input) => {
      try {
        return await claimInteractionPolicy(input);
      } catch (error) {
        // A policy stage is optional for a plain approval response. The
        // durable interaction store remains the source of truth for the
        // response itself; only an existing staged policy is claimed here.
        if (error instanceof InteractionPolicyStoreError && error.code === "not_found") {
          return null;
        }
        throw error;
      }
    },
    consumeInteractionPolicy,
    releaseInteractionPolicy,
    approvalRegistry: getApprovalRegistry(),
    steeringStore: getSteeringStore(),
    isStopRequested: async (streamId) => streamStore.hasStopFlag(streamId),
    clearStopFlag: async (streamId) => streamStore.clearStopFlag(streamId),
    releaseActiveRun,
    sessionExists: async (sessionId, userId) => Boolean(await prisma.chatSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } })),
    removeFailedPromptRow: removeFailedPromptForRetry,
    activeRuns: getActiveRunRegistry(),
  };
}

function mergeDependencies(input?: ChatRunWorkerDependencies): ChatRunWorkerDependencies & {
  streamStore: WorkerStreamStore;
  reconstruct: typeof reconstructChatRunInput;
  getContext7Server: typeof getContext7McpServer;
  interactionStore: Pick<InteractionStore, "onInteraction">;
  claimInteractionPolicy: (
    input: InteractionPolicyClaimInput,
  ) => Promise<InteractionPolicyClaimResult | null>;
  consumeInteractionPolicy: (input: InteractionPolicyClaimInput) => Promise<void>;
  releaseInteractionPolicy: (input: Pick<InteractionPolicyClaimInput, "interactionId" | "claimToken">) => Promise<void>;
  approvalRegistry: ApprovalPolicyRegistry;
  steeringStore: SteeringStore;
  isStopRequested: (streamId: string) => Promise<boolean>;
  clearStopFlag: (streamId: string) => Promise<void>;
  releaseActiveRun: typeof releaseActiveRun;
  sessionExists: (sessionId: string, userId: string) => Promise<boolean>;
  activeRuns: ActiveRunRegistry;
} {
  return { ...createDefaultDependencies(), ...input } as never;
}

async function claimResumePolicy(
  job: ResumeRunJob,
  deps: ReturnType<typeof mergeDependencies>,
): Promise<InteractionPolicyClaim | null> {
  const interaction = job.continuation.interaction;
  const response = parseAgentInteractionResponse(job.response);
  const input: InteractionPolicyClaimInput = {
    interactionId: interaction.id,
    userId: job.userId,
    sessionId: job.sessionId,
    toolName: interaction.toolName,
    responseFingerprint: interactionResponseFingerprint(response),
    claimToken: randomUUID(),
  };
  const policy = await deps.claimInteractionPolicy(input);
  if (!policy) return null;

  try {
    if (policy.grantScope === "session") {
      await deps.approvalRegistry.grantTool({
        sessionId: job.sessionId,
        toolName: interaction.toolName,
      });
    }
    // Interaction-scoped overrides are deliberately not written to the
    // session/tool registry. The worker installs them in a run-local
    // one-shot closure when the resumed tool actually asks for them.
    return { input, result: policy };
  } catch (error) {
    await deps.releaseInteractionPolicy({
      interactionId: input.interactionId,
      claimToken: input.claimToken,
    }).catch(() => undefined);
    throw error;
  }
}

async function appendClientEvent(
  store: WorkerStreamStore,
  streamId: string,
  event: ChatClientEvent,
): Promise<void> {
  await store.append({ streamId, event: toChatResumableEvent(event) });
}

async function appendSafeTerminal(
  store: WorkerStreamStore,
  streamId: string,
  runId: string,
  cancellation = false,
): Promise<void> {
  const stream = createChatClientStream({
    runId,
    metadata: undefined,
    events: toAsync([safeErrorEvent(cancellation ? { code: "CHAT_RUN_CANCELLED" } : undefined)]),
  });
  for await (const event of stream) await appendClientEvent(store, streamId, event);
}

function toAsync<T>(values: readonly T[]): AsyncIterable<T> {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

export function createChatRunProcessor(input?: ChatRunWorkerDependencies) {
  const deps = mergeDependencies(input);
  return async function process(job: Job<ChatRunJobData> | ChatRunJobData): Promise<void> {
    const data = "data" in job ? job.data : job;
    const parsed = parseChatRunJobData(data);
    const streamId = parsed.streamId;
    const status = await deps.streamStore.status({ streamId });
    if (status.status !== "running") {
      await deps.releaseActiveRun(parsed.sessionId, streamId).catch(() => undefined);
      return;
    }
    if (!deps.activeRuns.isAccepting) throw new Error("chat worker is shutting down");
    if (!(await deps.sessionExists(parsed.sessionId, parsed.userId))) {
      try {
        await appendSafeTerminal(deps.streamStore, streamId, streamId);
        await deps.streamStore.close({ streamId, status: "error" });
      } catch {
        // The session is already gone; the stream TTL remains the final
        // cleanup boundary if its terminal write is unavailable.
      }
      await deps.releaseActiveRun(parsed.sessionId, streamId).catch(() => undefined);
      return;
    }

    const controller = new AbortController();
    let nativeStream: AgentStream | null = null;
    let cancelled = false;
    let cancelReason = "chat run stopped";
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let stopMonitorDone = false;
    const cancelCurrentAttempt = (reason: string): void => {
      cancelled = true;
      cancelReason = reason;
      stopMonitorDone = true;
      if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      nativeStream?.cancel(reason);
      controller.abort(reason);
    };
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => { doneResolve = resolve; });
    const unregister = deps.activeRuns.register(streamId, {
      cancel(reason) {
        cancelCurrentAttempt(reason);
      },
      done,
    });
    let activeRunReleased = false;
    const releaseOwnedActiveRun = async (): Promise<void> => {
      if (activeRunReleased) return;
      activeRunReleased = true;
      await deps.releaseActiveRun(parsed.sessionId, streamId).catch(() => undefined);
    };
    let stopFlagCleared = false;
    const clearOwnedStopFlag = async (): Promise<void> => {
      if (stopFlagCleared) return;
      stopFlagCleared = true;
      await deps.clearStopFlag(streamId).catch(() => undefined);
    };
    const monitorStop = (): void => {
      if (stopMonitorDone) return;
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(async () => {
        stopTimer = null;
        if (stopMonitorDone) return;
        try {
          if (await deps.isStopRequested(streamId)) {
            cancelCurrentAttempt("client stop");
            return;
          }
        } finally {
          if (!stopMonitorDone) monitorStop();
        }
      }, STOP_POLL_MS);
    };

    const policyRegistry = deps.approvalRegistry;
    const appEvents = new AsyncEventQueue<ChatAppEvent>();
    let terminal: "response" | "interaction" | "blocked" | "error" | null = null;
    let attempt = 0;
    let resumePolicy: InteractionPolicyClaim | null = null;
    let policyConsumed = false;
    let resumeOverrideTaken = false;
    let interactionPersistenceFailed = false;
    try {
      if (await deps.isStopRequested(streamId)) {
        cancelCurrentAttempt("client stop");
      }

      // A stop observed before reconstruction is a pre-execution cancellation:
      // do not claim a resume policy or create an Agent/AgentStream that cannot
      // be allowed to execute. The common catch path writes one safe terminal.
      if (cancelled) {
        throw Object.assign(new Error(cancelReason), { code: "CHAT_RUN_CANCELLED" });
      }

      if (parsed.kind === "resume") resumePolicy = await claimResumePolicy(parsed, deps);

      if (cancelled) {
        throw Object.assign(new Error(cancelReason), { code: "CHAT_RUN_CANCELLED" });
      }

      const runInput = await deps.reconstruct({
        recipe: parsed.recipe,
        grantHelpers: {
          hasGrant: (toolName) => policyRegistry.hasToolGrant(parsed.sessionId, toolName),
          takeToolOverride: async (toolName) => {
            const policy = resumePolicy;
            const stagedOverride = policy?.result.overrideArgs;
            if (
              policy &&
              stagedOverride &&
              policy.result.toolName === toolName &&
              !resumeOverrideTaken
            ) {
              // The override becomes executable only at this run-local take
              // boundary. Consuming before returning prevents a crash from
              // exposing it to a later session/tool invocation.
              resumeOverrideTaken = true;
              try {
                await deps.consumeInteractionPolicy(policy.input);
                policyConsumed = true;
                return stagedOverride;
              } catch (error) {
                resumeOverrideTaken = false;
                throw error;
              }
            }
            return null;
          },
        },
        onDeepResearchProgress: async (event) => {
          appEvents.push({ type: "deep_research_progress", ...event });
        },
        context7Server: await deps.getContext7Server(),
      });

      for (;;) {
        const trace = {
          traceId: parsed.recipe.trace.traceId,
          sessionId: parsed.sessionId,
          userId: parsed.userId,
          name: "chat",
        };
        const streamInput: AgentRunOptions = parsed.kind === "start"
          ? {
              prompt: requireUserPrompt(parsed.prompt),
              session: { sessionId: parsed.sessionId, userId: parsed.userId, metadata: { streamId } },
              trace,
              abortSignal: controller.signal,
            }
          : {
              continuation: parsed.continuation,
              response: parsed.response,
              trace,
              abortSignal: controller.signal,
        };
        if (cancelled) {
          throw Object.assign(new Error(cancelReason), { code: "CHAT_RUN_CANCELLED" });
        }
        nativeStream = runInput.agent.stream(streamInput);
        if (resumePolicy && !policyConsumed) {
          // stream() returning is the execution acceptance boundary.  If the
          // consume transition fails after this point, leave the claim for its
          // lease/reconciliation path; releasing it could replay the tool.
          if (!resumePolicy.result.overrideArgs) {
            await deps.consumeInteractionPolicy(resumePolicy.input);
            policyConsumed = true;
          }
        }
        monitorStop();
        const prepared = await prepareAttempt(nativeStream, attempt);
        if (prepared.kind === "retry") {
          attempt += 1;
          nativeStream = null;
          if (parsed.kind === "start") {
            const clientMessageId = parsed.recipe.promptClientMessageId;
            if (!clientMessageId) throw new Error("transient retry requires a stable client message id");
            const removeFailedPromptRow = deps.removeFailedPromptRow;
            if (!removeFailedPromptRow) throw new Error("failed prompt cleanup is unavailable");
            await removeFailedPromptRow({ sessionId: parsed.sessionId, userId: parsed.userId, clientMessageId });
          }
          continue;
        }

        const pump = new SteeringPump(
          streamId,
          deps.steeringStore,
          () => nativeStream,
          async (applied) => {
            appEvents.push({
              type: "queued_message_applied",
              clientMessageId: applied.clientMessageId,
              attachmentCount: applied.attachments?.length ?? 0,
            });
            await deps.onSteeringApplied?.(applied);
          },
        );
        const observedEvents = (async function* (): AsyncGenerator<ChatStreamEvent> {
          let sawRoot = false;
          try {
            for await (const raw of prepared.events) {
              if (cancelled) throw Object.assign(new Error(cancelReason), { code: "CHAT_RUN_CANCELLED" });
              await pump.beforeEvent(raw);
              if (isRootTerminal(raw)) {
                sawRoot = true;
                terminal = raw.type;
              }
              yield sanitizeNativeEvent(raw);
              for (const appEvent of appEvents.drain()) yield appEvent;
              if (!sawRoot) await pump.afterEvent();
            }
            if (!sawRoot) yield safeErrorEvent();
          } catch (error) {
            if (!sawRoot) {
              terminal = "error";
              yield safeErrorEvent(error);
            }
          } finally {
            await pump.close({ requeueUnapplied: true });
          }
        })();

        const clientStream = createChatClientStream({
          runId: streamId,
          metadata: {
            sessionId: parsed.sessionId,
            modelId: parsed.recipe.model.id,
            reasoningEffort: parsed.recipe.model.reasoningEffort,
          },
          events: observedEvents,
          onInteraction: async (outcome) => {
            try {
              if (deps.persistInteraction) {
                await deps.persistInteraction({
                  outcome,
                  recipe: parsed.recipe,
                  sourceStreamId: streamId,
                  userId: parsed.userId,
                  sessionId: parsed.sessionId,
                });
              } else {
                await deps.interactionStore.onInteraction(outcome, parsed.recipe, {
                  userId: parsed.userId,
                  sessionId: parsed.sessionId,
                  sourceStreamId: streamId,
                });
              }
            } catch (error) {
              // @anvia/client turns this rejection into its masked error
              // terminal.  Keep the native raw interaction from being
              // mistaken for a successful suspended run in storage.
              interactionPersistenceFailed = true;
              throw error;
            }
          },
        });
        for await (const event of clientStream) {
          await appendClientEvent(deps.streamStore, streamId, event);
        }
        appEvents.end();
        if (interactionPersistenceFailed) terminal = "error";
        if (!terminal) terminal = "error";
        if (resumePolicy?.result.overrideArgs && !policyConsumed) {
          // The resumed run reached a native terminal without asking for its
          // staged override. Retain no executable policy beyond this run.
          await deps.consumeInteractionPolicy(resumePolicy.input);
          policyConsumed = true;
        }
        break;
      }

      const closeStatus = terminal === "error" ? "error" : "completed";
      await deps.streamStore.close({ streamId, status: closeStatus });
      await releaseOwnedActiveRun();
      await clearOwnedStopFlag();
      if (terminal === "error") throw safeError(cancelled ? { code: "CHAT_RUN_CANCELLED" } : undefined);
    } catch (error) {
      appEvents.end();
      if (resumePolicy && !policyConsumed && nativeStream === null) {
        await deps.releaseInteractionPolicy({
          interactionId: resumePolicy.input.interactionId,
          claimToken: resumePolicy.input.claimToken,
        }).catch(() => undefined);
      }
      const statusNow = await deps.streamStore.status({ streamId }).catch(() => ({ status: "running" as const, lastEventId: 0 }));
      if (statusNow.status === "running") {
        try {
          await appendSafeTerminal(deps.streamStore, streamId, streamId, cancelled);
          await deps.streamStore.close({ streamId, status: "error" });
        } catch (terminalError) {
          console.error("[chat-run] safe terminal append failed", terminalError);
        }
      }
      await releaseOwnedActiveRun();
      await clearOwnedStopFlag();
      throw safeError(error);
    } finally {
      stopMonitorDone = true;
      if (stopTimer) clearTimeout(stopTimer);
      unregister();
      doneResolve();
    }
  };
}

export async function processChatRunJob(
  job: Job<ChatRunJobData>,
  dependencies?: ChatRunWorkerDependencies,
): Promise<void> {
  return createChatRunProcessor(dependencies)(job);
}

/** Safe, idempotent terminal helper retained for BullMQ failed listeners. */
export async function failChatRun(
  streamId: string,
  _error: unknown,
  ctx?: { sessionId: string; userId: string },
): Promise<void> {
  const store = getStreamStore();
  try {
    const status = await store.status({ streamId });
    if (status.status === "running") {
      await appendSafeTerminal(store, streamId, streamId);
      await store.close({ streamId, status: "error" });
    }
  } catch (error) {
    console.error("[chat-run] fail close failed", error);
  }
  if (ctx) await releaseActiveRun(ctx.sessionId, streamId).catch(() => undefined);
}
