import { Queue, QueueEvents, type Job } from "bullmq";
import { getBullmqConnectionOptions, getRedis } from "../../lib/redis.js";
import { profileConfig } from "./service.js";
import type { ProfileScope } from "@assingment/agent";

export const PROFILE_QUEUE = "profile-summary";

export type ProfileRefreshJobData = {
  kind: "user" | "project";
  userId: string;
  projectId?: string | null;
  /** ISO timestamp of the first chat that opened the current debounce window. */
  firstRequestedAt: string;
};

export function profileDelayMs(): number {
  return profileConfig().delayMs;
}

export function profileJobId(scope: ProfileScope): string {
  return scope.kind === "user"
    ? `profile:user:${scope.userId}`
    : `profile:project:${scope.projectId}`;
}

let queue: Queue<ProfileRefreshJobData> | null = null;

export function getProfileQueue(): Queue<ProfileRefreshJobData> {
  if (!queue) {
    queue = new Queue<ProfileRefreshJobData>(PROFILE_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
  }
  return queue;
}

async function getPendingJob(
  scope: ProfileScope,
): Promise<Job<ProfileRefreshJobData> | null> {
  const job = await getProfileQueue().getJob(profileJobId(scope));
  if (!job) return null;
  const state = await job.getState();
  if (state === "waiting" || state === "delayed" || state === "active") return job;
  // failed / completed / unknown → stale, remove and let the caller re-add.
  await job.remove().catch(() => {});
  return null;
}

/**
 * Debounce with a bounded window: the job fires ~DELAY after the FIRST request
 * that opened the window, no matter how much activity follows (no starvation).
 * A job that is already active is left alone; the worker's finally block
 * (needs-refresh flag) guarantees a follow-up run.
 */
export async function enqueueProfileRefresh(scope: ProfileScope): Promise<void> {
  const existing = await getPendingJob(scope);
  const delayMs = profileDelayMs();

  if (existing) {
    const state = await existing.getState();
    if (state === "active") {
      await setNeedsProfileRefresh(scope);
      return;
    }
    const firstRequestedAt = existing.data.firstRequestedAt;
    const firstAt = firstRequestedAt ? Date.parse(firstRequestedAt) : NaN;
    const elapsed = Number.isFinite(firstAt) ? Date.now() - firstAt : delayMs;
    const nextDelay = Math.max(0, delayMs - elapsed);
    await existing.updateData({
      ...existing.data,
      firstRequestedAt: existing.data.firstRequestedAt ?? new Date().toISOString(),
    });
    await existing.changeDelay(nextDelay);
    return;
  }

  await getProfileQueue().add(
    profileJobId(scope),
    {
      kind: scope.kind,
      userId: scope.userId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      firstRequestedAt: new Date().toISOString(),
    },
    { delay: delayMs },
  );
}

/** Tool path: clear any pending window and start a fresh one. */
export async function rescheduleProfileRefresh(scope: ProfileScope): Promise<void> {
  await removePendingProfileJob(scope);
  await getProfileQueue().add(
    profileJobId(scope),
    {
      kind: scope.kind,
      userId: scope.userId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      firstRequestedAt: new Date().toISOString(),
    },
    { delay: profileDelayMs() },
  );
}

export async function removePendingProfileJob(scope: ProfileScope): Promise<void> {
  const job = await getProfileQueue().getJob(profileJobId(scope));
  if (!job) return;
  const state = await job.getState();
  if (state === "waiting" || state === "delayed") {
    await job.remove().catch(() => {});
  }
}

const needsRefreshKey = (scope: ProfileScope) => `profile:needs-refresh:${profileJobId(scope)}`;

export async function setNeedsProfileRefresh(scope: ProfileScope): Promise<void> {
  await getRedis().set(needsRefreshKey(scope), "1", "EX", 86400);
}

/** Atomically read-and-clear the flag. */
export async function takeNeedsProfileRefresh(scope: ProfileScope): Promise<boolean> {
  const redis = getRedis();
  const value = await redis.get(needsRefreshKey(scope));
  if (value === null) return false;
  await redis.del(needsRefreshKey(scope));
  return true;
}

// ─── Session-deletion reconsideration ──────────────────────────────────────
// Deleting a chat must not lose profile facts, but the profile should be
// re-examined: the summarizer (same worker, same queue, one LLM call) may
// remove facts that were clearly learned only from the deleted conversation.

export type PendingReconsideration = {
  deletedSessionId: string;
  snapshot: string;
  requestedAt: string;
};

const RECONSIDER_KEY_TTL_SECONDS = 86400;
const RECONSIDER_MAX_PENDING = 5;
const reconsiderKey = (scope: ProfileScope) =>
  `profile:reconsider:${profileJobId(scope)}`;

export async function getPendingReconsiderations(
  scope: ProfileScope,
): Promise<PendingReconsideration[]> {
  const raw = await getRedis().get(reconsiderKey(scope));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is PendingReconsideration =>
          !!item &&
          typeof item === "object" &&
          typeof (item as PendingReconsideration).deletedSessionId === "string" &&
          typeof (item as PendingReconsideration).snapshot === "string",
      );
    }
  } catch {
    // Malformed key — ignore; the next enqueue overwrites it.
  }
  return [];
}

/** Append a pending reconsideration (capped list); always keeps a job scheduled. */
export async function enqueueProfileReconsideration(
  scope: ProfileScope,
  info: Omit<PendingReconsideration, "requestedAt">,
): Promise<void> {
  const existing = await getPendingReconsiderations(scope);
  const next = [
    ...existing,
    { ...info, requestedAt: new Date().toISOString() },
  ].slice(-RECONSIDER_MAX_PENDING);
  await getRedis().set(
    reconsiderKey(scope),
    JSON.stringify(next),
    "EX",
    RECONSIDER_KEY_TTL_SECONDS,
  );
  await enqueueProfileRefresh(scope);
}

/** Clear pending reconsiderations after a successful profile pass. */
export async function clearPendingReconsiderations(
  scope: ProfileScope,
): Promise<void> {
  await getRedis().del(reconsiderKey(scope));
}

/**
 * Wait for an active job of this scope to finish (used by the remember tool so
 * two writers never race on the same profile row). Resolves on timeout.
 */
export async function waitForActiveProfileJob(
  scope: ProfileScope,
  ttlMs = 30_000,
): Promise<void> {
  const job = await getProfileQueue().getJob(profileJobId(scope));
  if (!job) return;
  const state = await job.getState();
  if (state !== "active") return;

  const events = new QueueEvents(PROFILE_QUEUE, {
    connection: getBullmqConnectionOptions(),
  });
  events.on("error", (error) => {
    console.error("[profile] queue events error", error);
  });
  try {
    await job.waitUntilFinished(events, ttlMs);
  } catch {
    // Timeout or events failure — proceed anyway; reschedule still guarantees consistency.
  } finally {
    await events.close().catch(() => {});
  }
}
