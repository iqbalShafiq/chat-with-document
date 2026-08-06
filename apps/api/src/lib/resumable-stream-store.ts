import type { Redis } from "ioredis";
import type {
  ResumableStreamCloseInput,
  ResumableStreamOpenInput,
  ResumableStreamRecord,
  ResumableStreamState,
  ResumableStreamStore,
  ResumableStreamStatus,
  ResumableStreamSubscribeInput,
} from "@anvia/server";
import { getRedis } from "./redis.js";

export type StreamMeta = {
  userId: string;
  sessionId: string;
  modelId: string;
  reasoningEffort: string | null;
};

const STATUS_KEY = (streamId: string) => `rs:${streamId}`;
const EVENTS_KEY = (streamId: string) => `rs:${streamId}:events`;
const COUNTER_KEY = (streamId: string) => `rs:${streamId}:counter`;
const STOP_KEY = (streamId: string) => `rs-stop:${streamId}`;

const OPEN_TTL_SECONDS = 6 * 60 * 60;
const CLOSE_TTL_SECONDS = 24 * 60 * 60;
const SENTINEL = "__end__";
const BLOCK_MS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventId(streamEntryId: string): number {
  const index = streamEntryId.indexOf("-");
  const base = index === -1 ? streamEntryId : streamEntryId.slice(0, index);
  const parsed = Number(base);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createRedisResumableStreamStore(
  redis: Redis,
): ResumableStreamStore & {
  openWithMeta(
    input: ResumableStreamOpenInput,
    meta: StreamMeta,
  ): Promise<ResumableStreamState>;
  getMeta(streamId: string): Promise<StreamMeta | null>;
  setStopFlag(streamId: string): Promise<void>;
} {
  const stateFromHash = async (streamId: string): Promise<ResumableStreamState> => {
    const status = await redis.hget(STATUS_KEY(streamId), "status");
    if (status === null) return { status: "missing", lastEventId: 0 };
    const counter = await redis.get(COUNTER_KEY(streamId));
    return {
      status: status as ResumableStreamStatus,
      lastEventId: Number(counter ?? 0),
    };
  };

  const store: ResumableStreamStore = {
    async open(input: ResumableStreamOpenInput): Promise<ResumableStreamState> {
      const existing = await redis.hget(STATUS_KEY(input.streamId), "status");
      if (existing !== null && existing !== "missing") {
        return stateFromHash(input.streamId);
      }
      await redis.hset(STATUS_KEY(input.streamId), "status", "running");
      await redis.del(EVENTS_KEY(input.streamId), COUNTER_KEY(input.streamId));
      await redis.expire(STATUS_KEY(input.streamId), OPEN_TTL_SECONDS);
      await redis.expire(EVENTS_KEY(input.streamId), OPEN_TTL_SECONDS);
      return { status: "running", lastEventId: 0 };
    },

    async append(input: {
      streamId: string;
      event: unknown;
    }): Promise<ResumableStreamRecord<unknown>> {
      const status = await redis.hget(STATUS_KEY(input.streamId), "status");
      if (status !== "running") {
        throw new Error(`Resumable stream "${input.streamId}" is not running (${status ?? "missing"})`);
      }
      const eventId = await redis.incr(COUNTER_KEY(input.streamId));
      await redis.xadd(EVENTS_KEY(input.streamId), `${eventId}-0`, "e", JSON.stringify(input.event));
      await redis.expire(EVENTS_KEY(input.streamId), OPEN_TTL_SECONDS);
      return {
        streamId: input.streamId,
        eventId,
        event: input.event,
        createdAt: new Date(),
      };
    },

    subscribe(input: ResumableStreamSubscribeInput) {
      const after = input.after ?? 0;
      return {
        [Symbol.asyncIterator](): AsyncIterator<ResumableStreamRecord<unknown>> {
          let lastRead = after;
          let finished = false;
          const next = async (): Promise<IteratorResult<ResumableStreamRecord<unknown>>> => {
            while (!finished) {
              const status = await redis.hget(STATUS_KEY(input.streamId), "status");
              const rows = await redis.xrange(
                EVENTS_KEY(input.streamId),
                `(${lastRead}-0`,
                "+",
                "COUNT",
                128,
              );
              for (const [entryId, fields] of rows) {
                const eventId = parseEventId(entryId);
                if (eventId <= lastRead) continue;
                const raw = fields[1];
                let event: unknown;
                try {
                  event = JSON.parse(raw);
                } catch {
                  event = { raw };
                }
                if (isRecord(event) && event.__end__ !== undefined) {
                  finished = true;
                  return { value: undefined, done: true };
                }
                lastRead = eventId;
                return {
                  value: { streamId: input.streamId, eventId, event, createdAt: new Date() },
                  done: false,
                };
              }
              if (status !== null && status !== "running") {
                finished = true;
                return { value: undefined, done: true };
              }
              if (status === null && rows.length === 0) {
                // Stream never opened: end immediately (stale resume).
                finished = true;
                return { value: undefined, done: true };
              }
              await redis.xread(
                // ioredis only declares the "COUNT"-then-"BLOCK" argument order for XREAD;
                // the "BLOCK"-then-"COUNT" order is wire-identical but not in the overloads.
                "COUNT",
                64,
                "BLOCK",
                BLOCK_MS,
                "STREAMS",
                EVENTS_KEY(input.streamId),
                `${lastRead}-0`,
              );
            }
            return { value: undefined, done: true };
          };
          return { next };
        },
      };
    },

    async status(input: { streamId: string }): Promise<ResumableStreamState> {
      return stateFromHash(input.streamId);
    },

    async close(input: ResumableStreamCloseInput): Promise<ResumableStreamState> {
      const current = await redis.hget(STATUS_KEY(input.streamId), "status");
      if (current === null || current === input.status) {
        return stateFromHash(input.streamId);
      }
      await redis.hset(STATUS_KEY(input.streamId), "status", input.status);
      const counter = await redis.get(COUNTER_KEY(input.streamId));
      const nextId = (Number(counter ?? 0) + 1);
      await redis.xadd(
        EVENTS_KEY(input.streamId),
        `${nextId}-0`,
        "e",
        JSON.stringify({ __end__: input.status }),
      );
      await redis.expire(STATUS_KEY(input.streamId), CLOSE_TTL_SECONDS);
      await redis.expire(EVENTS_KEY(input.streamId), CLOSE_TTL_SECONDS);
      return stateFromHash(input.streamId);
    },
  };

  return {
    ...store,
    async openWithMeta(input: ResumableStreamOpenInput, meta: StreamMeta): Promise<ResumableStreamState> {
      const state = await store.open(input);
      if (state.status === "running") {
        await redis.hset(STATUS_KEY(input.streamId), {
          userId: meta.userId,
          sessionId: meta.sessionId,
          modelId: meta.modelId,
          reasoningEffort: meta.reasoningEffort ?? "",
        });
      }
      return state;
    },
    async getMeta(streamId: string): Promise<StreamMeta | null> {
      const hash = await redis.hgetall(STATUS_KEY(streamId));
      if (!hash.status) return null;
      return {
        userId: hash.userId ?? "",
        sessionId: hash.sessionId ?? "",
        modelId: hash.modelId ?? "",
        reasoningEffort: hash.reasoningEffort || null,
      };
    },
    async setStopFlag(streamId: string): Promise<void> {
      await redis.set(STOP_KEY(streamId), "1", "EX", 600);
    },
  };
}

export type ResumableStreamStoreWithMeta = ReturnType<
  typeof createRedisResumableStreamStore
>;

let streamStore: ResumableStreamStoreWithMeta | null = null;

/** Process-wide singleton store; shared by the chat router and run worker. */
export function getStreamStore(): ResumableStreamStoreWithMeta {
  if (!streamStore) {
    streamStore = createRedisResumableStreamStore(getRedis());
  }
  return streamStore;
}
