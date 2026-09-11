import { getRedis } from "../../lib/redis.js";
import type { Redis } from "ioredis";
import {
  getStreamStore,
  type ResumableStreamStoreWithMeta,
} from "../../lib/resumable-stream-store.js";
import { releaseActiveRun } from "./run-queue.js";
import { RUN_OWNER_WAL_KEY, RUN_CREATED_KEY } from "./run-worker.js";
import { createChatClientStream, toChatResumableEvent } from "./client-events.js";
import type { ChatResumableEvent } from "./client-events.js";

const SWEEP_INTERVAL_MS = 15_000;
const WAL_STALE_MS = 60_000;
const ACTIVE_KEY_GRACE_MS = 30_000;
const ACTIVE_RUN_KEY_PREFIX = "rs-active:";
const ACTIVE_RUN_KEY = (sessionId: string) => `${ACTIVE_RUN_KEY_PREFIX}${sessionId}`;

type WatchdogStore = Pick<
  ResumableStreamStoreWithMeta,
  "status" | "close"
> & {
  append(input: { streamId: string; event: ChatResumableEvent }): Promise<unknown>;
};

/** Tests may substitute a fake Redis and stream store. */
export type RunStaleWatchdogOptions = {
  redis?: Redis;
  store?: WatchdogStore;
  intervalMs?: number;
  walStaleMs?: number;
  walGraceMs?: number;
  scanKeys?: (redis: Redis, pattern: string) => Promise<string[]>;
  releaseActiveRun?: typeof releaseActiveRun;
};

function defaultScanKeys(redis: Redis, pattern: string): Promise<string[]> {
  return redis.keys(pattern);
}

function toAsync<T>(values: readonly T[]): AsyncIterable<T> {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

/** Write the same terminal pair the worker writes on failure: error + run_end error. */
export async function closeStaleRun(
  streamId: string,
  sessionId: string,
  store: WatchdogStore,
  release: typeof releaseActiveRun,
): Promise<void> {
  try {
    const status = await store.status({ streamId });
    if (status.status !== "running") return;
    const stream = createChatClientStream({
      runId: streamId,
      metadata: undefined,
      events: toAsync([
        {
          type: "error",
          error: {
            code: "CHAT_RUN_FAILED",
            message: "Something went wrong while answering. Send again.",
          },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      ]),
    });
    for await (const event of stream) {
      await store.append({ streamId, event: toChatResumableEvent(event) });
    }
    await store.close({ streamId, status: "error" });
  } catch {
    // Best effort: the stream TTL remains the last-resort cleanup.
  }
  await release(sessionId, streamId).catch(() => undefined);
}

/**
 * Scans for streams the API process thinks are still running but whose owner
 * WAL (written by the chat worker) is stale or missing — meaning the worker
 * died or restarted mid-run. Those runs are closed as errored so SSE clients
 * receive a terminal and never hang in "Working" forever.
 */
export async function sweepStaleRuns(opts: RunStaleWatchdogOptions = {}): Promise<void> {
  const redis = opts.redis ?? getRedis();
  const store = opts.store ?? (getStreamStore() as unknown as WatchdogStore);
  const scanKeys = opts.scanKeys ?? defaultScanKeys;
  const walStaleMs = opts.walStaleMs ?? WAL_STALE_MS;
  const walGraceMs = opts.walGraceMs ?? ACTIVE_KEY_GRACE_MS;
  const release = opts.releaseActiveRun ?? releaseActiveRun;
  const now = Date.now();

  let keys: string[];
  try {
    keys = await scanKeys(redis, `${ACTIVE_RUN_KEY_PREFIX}*`);
  } catch {
    return;
  }
  for (const key of keys) {
    const sessionId = key.slice(ACTIVE_RUN_KEY_PREFIX.length);
    if (!sessionId) continue;
    let streamId: string | null = null;
    try {
      streamId = await redis.get(key);
    } catch {
      continue;
    }
    if (!streamId) continue;
    let wal: string | null = null;
    try {
      wal = await redis.get(RUN_OWNER_WAL_KEY(streamId));
    } catch {
      continue;
    }
    if (wal === null) {
      // No WAL yet. Differentiate "just created" (worker still booting) from
      // "long abandoned": when the run stream was opened more than the grace
      // window ago and no worker ever claimed it, close it.
      const created = await redis.get(RUN_CREATED_KEY(streamId)).catch(() => null);
      if (created === null) continue; // legacy stream without marker; leave it
      const createdTs = Number(created);
      if (!Number.isFinite(createdTs)) continue;
      if (now - createdTs < walGraceMs) continue;
      // fall through to close (stream status re-check below)
    } else {
      const walTs = Number(wal);
      if (!Number.isFinite(walTs)) continue;
      if (now - walTs < walStaleMs) continue;
    }

    let status: { status: string } = { status: "running" };
    try {
      status = await store.status({ streamId });
    } catch {
      continue;
    }
    if (status.status !== "running") continue;

    // Worker died and the stream is still running. Close it as errored.
    console.warn(`[chat-run] stale run ${streamId} (session ${sessionId}) closed by watchdog`);
    await closeStaleRun(streamId, sessionId, store, release);
  }
}

export function startRunStaleSweeper(
  opts: RunStaleWatchdogOptions = {},
): ReturnType<typeof setInterval> {
  const intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
  void sweepStaleRuns(opts);
  return setInterval(() => {
    void sweepStaleRuns(opts);
  }, intervalMs);
}

export type { WatchdogStore };
export { RUN_OWNER_WAL_KEY, RUN_CREATED_KEY, ACTIVE_RUN_KEY };