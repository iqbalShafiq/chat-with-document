import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import {
  parseMessage,
  type Message,
} from "@anvia/core/completion";
import {
  assertAgentInteractionResponse,
  parseAgentContinuation,
  parseAgentInteractionResponse,
  type AgentContinuation,
  type AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import z from "zod";
import { getBullmqConnectionOptions, getRedis } from "../../lib/redis.js";
import {
  assertRecipeIdentity,
  chatAgentRecipeSchema,
  commitChatAgentRecipeClaim,
  releaseChatAgentRecipeClaim,
  type ChatAgentRecipe,
} from "./run-recipe.js";
import type {
  InteractionOwnership,
  InteractionStore,
} from "./interaction-store.js";

export const CHAT_RUN_QUEUE = "chat-run";

const jobText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "must not be blank");

const queueIdentity = jobText(256);
const createdAtSchema = z.string().datetime({ offset: true }).max(64);

/** Parse the official v1 message contract and only permit a fresh user turn. */
const promptSchema = z.unknown().transform((value, ctx): Message => {
  try {
    const message = parseMessage(value);
    if (message.role !== "user") {
      ctx.addIssue({ code: "custom", message: "start prompt must be a user message" });
      return z.NEVER;
    }
    return message;
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid v1 message",
    });
    return z.NEVER;
  }
});

const continuationSchema = z
  .unknown()
  .transform((value, ctx): AgentContinuation => {
    try {
      return parseAgentContinuation(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "invalid agent continuation",
      });
      return z.NEVER;
    }
  });

const responseSchema = z
  .unknown()
  .transform((value, ctx): AgentInteractionResponse => {
    try {
      return parseAgentInteractionResponse(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "invalid interaction response",
      });
      return z.NEVER;
    }
  });

const startRunJobSchema = z
  .object({
    kind: z.literal("start"),
    streamId: queueIdentity,
    sessionId: queueIdentity,
    userId: queueIdentity,
    recipe: chatAgentRecipeSchema,
    prompt: promptSchema,
    createdAt: createdAtSchema,
  })
  .strict();

const resumeRunJobSchema = z
  .object({
    kind: z.literal("resume"),
    streamId: queueIdentity,
    sessionId: queueIdentity,
    userId: queueIdentity,
    recipe: chatAgentRecipeSchema,
    continuation: continuationSchema,
    response: responseSchema,
    sourceInteractionId: queueIdentity,
    createdAt: createdAtSchema,
  })
  .strict()
  .superRefine((job, ctx) => {
    if (job.continuation.agentId !== job.recipe.agentId) {
      ctx.addIssue({
        code: "custom",
        path: ["continuation", "agentId"],
        message: "continuation agent id does not match recipe",
      });
    }
    if (job.sourceInteractionId !== job.continuation.interaction.id) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceInteractionId"],
        message: "source interaction id does not match continuation",
      });
    }
    try {
      assertAgentInteractionResponse(job.continuation.interaction, job.response);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["response"],
        message:
          error instanceof Error
            ? error.message
            : "interaction response does not match continuation",
      });
    }
  });

export const chatRunJobSchema = z
  .discriminatedUnion("kind", [startRunJobSchema, resumeRunJobSchema])
  .superRefine((job, ctx) => {
    try {
      assertRecipeIdentity(job.recipe, {
        sessionId: job.sessionId,
        userId: job.userId,
      });
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["recipe", "identity"],
        message: error instanceof Error ? error.message : "identity mismatch",
      });
    }
  });

export type StartRunJob = z.infer<typeof startRunJobSchema>;
export type ResumeRunJob = z.infer<typeof resumeRunJobSchema>;
export type ChatRunJobData = z.infer<typeof chatRunJobSchema>;

/** Stable BullMQ id for one interaction response; claim tokens stay out of jobs. */
export function interactionResumeJobId(interactionId: string): string {
  const id = queueIdentity.parse(interactionId);
  return `chat-resume:${createHash("sha256").update(id).digest("hex")}`;
}

/** Validate a job before it is allowed to enter Redis/BullMQ. */
export function parseChatRunJobData(value: unknown): ChatRunJobData {
  return chatRunJobSchema.parse(value);
}

export const parseRunJob = parseChatRunJobData;

let queue: Queue<ChatRunJobData> | null = null;

export function getChatRunQueue(): Queue<ChatRunJobData> {
  if (!queue) {
    queue = new Queue<ChatRunJobData>(CHAT_RUN_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}

export async function enqueueChatRun(
  jobId: string,
  data: ChatRunJobData,
  queueOverride?: Pick<Queue<ChatRunJobData>, "add">,
): Promise<void> {
  const claimOwner = data.recipe;
  let accepted = false;
  try {
    const parsed = parseChatRunJobData(data);
    await (queueOverride ?? getChatRunQueue()).add(jobId, parsed);
    accepted = true;
    await commitChatAgentRecipeClaim(claimOwner);
  } catch (error) {
    // Once BullMQ accepted the job, releasing its durable claim would expose
    // the same context to a second run. Keep the claim for commit retry/reap;
    // only a validation or enqueue failure is reversible here.
    if (accepted) throw error;
    try {
      await releaseChatAgentRecipeClaim(claimOwner);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "chat run enqueue failed and context rollback failed",
      );
    }
    throw error;
  }
}

export type ChatResumeEnqueueOptions = {
  interactionStore: Pick<InteractionStore, "get" | "claim" | "release" | "consume">;
  ownership: InteractionOwnership;
  queueOverride?: Pick<Queue<ChatRunJobData>, "add">;
  token?: string;
};

export type ChatResumeEnqueueResult = {
  jobId: string;
  record: Awaited<ReturnType<InteractionStore["consume"]>>;
  reconciled: boolean;
};

/** Stable, prompt-free diagnostic for an accepted job awaiting reconciliation. */
export class ChatResumeReconciliationError extends Error {
  readonly code = "resume_reconciliation_pending" as const;
  constructor(readonly jobId: string, cause?: unknown) {
    super(`resume job ${jobId} was accepted but its durable consume marker needs reconciliation`);
    this.name = "ChatResumeReconciliationError";
    if (cause instanceof Error) this.cause = cause;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Claim, enqueue, and consume one interaction as a single ownership
 * protocol. A queue add failure releases the claim; after BullMQ accepts the
 * job the claim is intentionally retained until consume succeeds or the
 * lease reaper recovers it. The claim token never enters the job payload.
 */
export async function enqueueChatResume(
  interactionId: string,
  data: ResumeRunJob,
  options: ChatResumeEnqueueOptions,
): Promise<ChatResumeEnqueueResult> {
  const parsed = parseChatRunJobData(data);
  if (parsed.kind !== "resume" || parsed.sourceInteractionId !== interactionId) {
    throw new Error("resume interaction id does not match the queue payload");
  }
  const jobId = interactionResumeJobId(interactionId);
  const current = await options.interactionStore.get(interactionId, options.ownership);
  if (!current) throw new Error(`interaction ${interactionId} was not found`);
  if (
    current.id !== parsed.sourceInteractionId ||
    current.userId !== parsed.userId ||
    current.sessionId !== parsed.sessionId ||
    canonicalJson(current.continuation) !== canonicalJson(parsed.continuation) ||
    canonicalJson(current.recipe) !== canonicalJson(parsed.recipe)
  ) {
    throw new Error("resume payload does not match the immutable interaction record");
  }

  // A process that crashed after queue acceptance can reconcile without the
  // old in-memory claim token. The store's Lua consume script validates the
  // deterministic job id, immutable fingerprint, and exact response.
  if (current.state === "consumed") {
    const reconciled = await options.interactionStore.consume({
      id: interactionId,
      userId: options.ownership.userId,
      sessionId: options.ownership.sessionId,
      jobId,
      resumeStreamId: parsed.streamId,
      response: parsed.response,
    });
    return { jobId, record: reconciled, reconciled: true };
  }

  const claim = await options.interactionStore.claim(interactionId, {
    userId: options.ownership.userId,
    sessionId: options.ownership.sessionId,
    token: options.token,
    fingerprint: current.fingerprint,
    resumeStreamId: parsed.streamId,
    response: parsed.response,
  });
  let accepted = false;
  try {
    await (options.queueOverride ?? getChatRunQueue()).add(jobId, parsed);
    accepted = true;
    const consumed = await options.interactionStore.consume({
      id: interactionId,
      userId: options.ownership.userId,
      sessionId: options.ownership.sessionId,
      token: claim.token,
      jobId,
      resumeStreamId: parsed.streamId,
      response: parsed.response,
    });
    return { jobId, record: consumed, reconciled: false };
  } catch (error) {
    if (accepted) throw new ChatResumeReconciliationError(jobId, error);
    try {
      await options.interactionStore.release({
        id: interactionId,
        userId: options.ownership.userId,
        sessionId: options.ownership.sessionId,
        token: claim.token,
      });
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "interaction enqueue failed and claim release failed",
      );
    }
    throw error;
  }
}

export const ACTIVE_RUN_KEY = (sessionId: string) => `rs-active:${sessionId}`;

const ACTIVE_RUN_TTL_SECONDS = 600;

/** SET NX: claim the session's single active run. False when one is running. */
export async function tryAcquireActiveRun(
  sessionId: string,
  streamId: string,
  ttlSeconds?: number,
): Promise<boolean> {
  const result = await getRedis().set(
    ACTIVE_RUN_KEY(sessionId),
    streamId,
    "EX",
    ttlSeconds ?? ACTIVE_RUN_TTL_SECONDS,
    "NX",
  );
  return result === "OK";
}

/** Compare-and-delete: only release the lock we actually own. */
export async function releaseActiveRun(
  sessionId: string,
  streamId: string,
): Promise<void> {
  const redis = getRedis();
  const current = await redis.get(ACTIVE_RUN_KEY(sessionId));
  if (current === streamId) {
    await redis.del(ACTIVE_RUN_KEY(sessionId));
  }
}
