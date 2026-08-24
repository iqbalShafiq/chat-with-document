import { Queue } from "bullmq";
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
