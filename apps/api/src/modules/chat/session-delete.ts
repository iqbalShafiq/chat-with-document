import type { ProfileScope } from "@assingment/agent";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { prisma } from "../../utils/prisma.js";
import { enqueueProfileReconsideration } from "../profiling/queue.js";
import { profileConfig } from "../profiling/service.js";
import { getApprovalRegistry } from "./approval-registry.js";
import {
  deleteChatSessionsHard,
  getChatSession,
} from "./chat-session.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";
import { ACTIVE_RUN_KEY, getChatRunQueue } from "./run-queue.js";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the worker to end the run (stop flag + unblock human-input waiters),
 * then wait for the active-run lock to be released by the worker. Returns
 * true when a running stream was stopped. Throws SessionRunActiveError when
 * the run cannot settle within the timeout — delete must NOT race the
 * worker, because the memory store upserts its session row and could
 * resurrect the deleted session.
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

  // Liveness: if the chat-run job is no longer active (completed / failed /
  // unknown), no worker can write memory — the lock is orphaned. Drop it.
  const runJob = await getChatRunQueue().getJob(`chat:${streamId}`);
  if (runJob && (await runJob.getState()) !== "active") {
    await redis.del(ACTIVE_RUN_KEY(sessionId));
    return false;
  }

  await store.setStopFlag(streamId);
  await getApprovalRegistry()
    .cancelPendingForStream(streamId)
    .catch(() => ({ approvals: 0, clarifications: 0 }));

  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await redis.get(ACTIVE_RUN_KEY(sessionId));
    if (!current) return true;
    await sleep(RUN_SETTLE_POLL_MS);
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

  const relocked = await getRedis().get(ACTIVE_RUN_KEY(sessionId));
  if (relocked) throw new SessionRunActiveError();

  const reconsiderEnabled = profileConfig().enabled;
  const snapshot = reconsiderEnabled
    ? await captureSessionSnapshot(userId, sessionId)
    : "";
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
