import type { ProfileScope } from "@anreal/agent";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { prisma } from "../../utils/prisma.js";
import { enqueueProfileReconsideration } from "../profiling/queue.js";
import { profileConfig } from "../profiling/service.js";
import {
  deleteChatSessionsHard,
  getChatSession,
} from "./chat-session.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";
import {
  ACTIVE_RUN_KEY,
  getChatRunQueue,
  releaseActiveRun,
} from "./run-queue.js";
import { extractTextFromMessageJson } from "./session-list.js";
import { buildSessionSnapshotText } from "./session-snapshot.js";

export class SessionRunActiveError extends Error {
  readonly code = "SESSION_RUN_ACTIVE";
  constructor(message = "Session is still processing; try again in a moment") {
    super(message);
    this.name = "SessionRunActiveError";
  }
}

const RUN_SETTLE_TIMEOUT_MS = 12000;
const RUN_SETTLE_POLL_MS = 400;
/** Enqueue happens milliseconds after the lock; two empty polls are enough. */
const MISSING_JOB_POLLS_BEFORE_ABANDON = 2;

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "unknown"]);
const QUEUED_JOB_STATES = new Set([
  "waiting",
  "delayed",
  "paused",
  "waiting-children",
  "prioritized",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type QueueJob = {
  data?: { streamId?: string };
  getState(): Promise<string>;
  remove(): Promise<void>;
};

async function findChatRunJob(streamId: string): Promise<QueueJob | null> {
  const queue = getChatRunQueue();
  const byStartId = (await queue.getJob(`chat:${streamId}`)) as QueueJob | undefined;
  if (byStartId) return byStartId;
  if (typeof queue.getJobs !== "function") return null;
  const jobs = (await queue.getJobs(
    [
      "active",
      "waiting",
      "delayed",
      "paused",
      "waiting-children",
      "prioritized",
    ],
    0,
    500,
  )) as QueueJob[];
  return jobs.find((job) => job.data?.streamId === streamId) ?? null;
}

async function closeRunningStream(
  store: ReturnType<typeof getStreamStore>,
  streamId: string,
): Promise<void> {
  try {
    const state = await store.status({ streamId });
    if (state.status === "running") {
      await store.close({ streamId, status: "error" });
    }
  } catch {
    // Already closed, missing, or a concurrent worker closed it.
  }
}

async function abandonLockedRun(
  sessionId: string,
  streamId: string,
): Promise<void> {
  await closeRunningStream(getStreamStore(), streamId);
  await releaseActiveRun(sessionId, streamId);
}

async function tryRemoveQueuedJob(job: QueueJob): Promise<boolean> {
  const state = await job.getState();
  if (TERMINAL_JOB_STATES.has(state)) return true;
  if (!QUEUED_JOB_STATES.has(state)) return false;
  try {
    await job.remove();
    return true;
  } catch {
    // Lost the race: the worker claimed the job. Cooperative stop continues.
    return false;
  }
}

/**
 * Ask the worker to end the run (stop flag + native stream cancellation),
 * then wait for the active-run lock to be released. Queued jobs are removed
 * immediately so a stuck/waiting worker cannot pin the session. Throws
 * SessionRunActiveError when an *active* worker does not settle in time —
 * delete must NOT race a live memory upsert that could resurrect the row.
 */
export async function stopActiveRunForSession(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const redis = getRedis();
  const store = getStreamStore();
  const streamId = await redis.get(ACTIVE_RUN_KEY(sessionId));
  if (!streamId) return false;

  const state = await store.status({ streamId });
  if (state.status !== "running") {
    // Stale lock from a crashed run — drop it so the delete can proceed.
    await redis.del(ACTIVE_RUN_KEY(sessionId));
    return false;
  }

  const runJob = await findChatRunJob(streamId);
  if (runJob) {
    const jobState = await runJob.getState();
    if (TERMINAL_JOB_STATES.has(jobState)) {
      // Terminal job — no worker can write memory anymore. Stale lock.
      await redis.del(ACTIVE_RUN_KEY(sessionId));
      return false;
    }
  }

  await store.setStopFlag(streamId);

  if (runJob && (await tryRemoveQueuedJob(runJob))) {
    await abandonLockedRun(sessionId, streamId);
    return true;
  }

  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  let missingPolls = runJob ? 0 : 1;
  while (Date.now() < deadline) {
    const current = await redis.get(ACTIVE_RUN_KEY(sessionId));
    if (!current) return true;

    const liveJob = await findChatRunJob(current);
    if (!liveJob) {
      missingPolls += 1;
      if (missingPolls >= MISSING_JOB_POLLS_BEFORE_ABANDON) {
        await abandonLockedRun(sessionId, current);
        return true;
      }
    } else if (await tryRemoveQueuedJob(liveJob)) {
      await abandonLockedRun(sessionId, current);
      return true;
    } else {
      missingPolls = 0;
    }
    await sleep(RUN_SETTLE_POLL_MS);
  }

  const leftover = await redis.get(ACTIVE_RUN_KEY(sessionId));
  if (!leftover) return true;

  const leftoverJob = await findChatRunJob(leftover);
  const leftoverState = leftoverJob ? await leftoverJob.getState() : "unknown";
  if (leftoverState !== "active") {
    await abandonLockedRun(sessionId, leftover);
    return true;
  }
  throw new SessionRunActiveError();
}

async function captureSessionSnapshot(
  userId: string,
  sessionId: string,
): Promise<string> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId, userId);
  const memorySession = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (!memorySession) return "";
  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: memorySession.id, role: "user" },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { createdAt: true, message: true },
  });
  const texts: Array<{ createdAt: Date; text: string }> = [];
  for (const row of rows) {
    const text = extractTextFromMessageJson(row.message)?.trim() ?? "";
    if (text) texts.push({ createdAt: row.createdAt, text });
  }
  return buildSessionSnapshotText(texts);
}

/**
 * Delete a chat session for the user:
 * 1. ownership check (404),
 * 2. stop an active run if any (stop flag → poll lock release; 409 on timeout),
 * 3. capture a bounded message snapshot (before rows vanish),
 * 4. hard delete,
 * 5. best-effort enqueue profile reconsideration (user + project scopes).
 */
export async function deleteChatSession(
  userId: string,
  sessionId: string,
): Promise<{ deleted: true; hadActiveRun: boolean }> {
  const chatSession = await getChatSession(userId, sessionId);
  const hadActiveRun = await stopActiveRunForSession(userId, sessionId);

  const reconsiderEnabled = profileConfig().enabled;
  const snapshot = reconsiderEnabled
    ? await captureSessionSnapshot(userId, sessionId)
    : "";

  // The snapshot reads (10-100ms) leave a window where a stale second tab can
  // re-acquire the lock and start a new run, whose worker would resurrect the
  // session via the memory store's upsert. Re-check immediately before the
  // hard delete; the worker-side existence guard covers the final window.
  const relocked = await getRedis().get(ACTIVE_RUN_KEY(sessionId));
  if (relocked) throw new SessionRunActiveError();

  await deleteChatSessionsHard(userId, [sessionId]);

  if (reconsiderEnabled && snapshot.length > 0) {
    const scopes: ProfileScope[] = [{ kind: "user", userId }];
    if (chatSession.projectId) {
      scopes.push({
        kind: "project",
        userId,
        projectId: chatSession.projectId,
      });
    }
    for (const scope of scopes) {
      enqueueProfileReconsideration(scope, {
        deletedSessionId: sessionId,
        snapshot,
      }).catch((error: unknown) => {
        console.error("[sessions] profile reconsider enqueue failed", error);
      });
    }
  }

  return { deleted: true, hadActiveRun };
}
