import { randomUUID } from "node:crypto";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "@anvia/core";
import type { Redis } from "ioredis";
import { getRedis } from "../../lib/redis.js";

/**
 * Redis-backed approval registry powering AgentBuilder.approvals.
 *
 * The handler receives a pending tool call (e.g. web_search while the
 * per-session web toggle is off), stores the request in Redis, emits a
 * `tool_approval_request` stream event so the UI can ask the user, then
 * polls for the decision key. The API route writes that key via
 * `publishDecision`; a timeout auto-rejects. Polling (500ms) is chosen over
 * pub/sub so the registry works across the API and worker processes with
 * zero extra connections and stays trivially testable.
 */

export const APPROVAL_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const APPROVAL_TTL_SECONDS = 15 * 60;
const DECISION_TTL_SECONDS = 5 * 60;
const POLL_INTERVAL_MS = 500;

const APPROVAL_KEY = (approvalId: string) => `chat-approval:${approvalId}`;
const DECISION_KEY = (approvalId: string) =>
  `chat-approval:${approvalId}:decision`;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "timed_out";

export type PendingApprovalRecord = {
  approvalId: string;
  userId: string;
  sessionId: string;
  streamId: string;
  toolName: string;
  args: string;
  reason?: string;
  status: ApprovalStatus;
  requestedAt: string;
};

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
  decidedAt: string;
};

/** Narrow surface used by the registry so tests can inject a fake. */
export type ApprovalRedis = Pick<
  Redis,
  "hset" | "hgetall" | "expire" | "get" | "set" | "del"
>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDecision(
  redis: ApprovalRedis,
  approvalId: string,
  timeoutMs: number,
): Promise<ApprovalDecision | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await redis.get(DECISION_KEY(approvalId));
    if (raw) {
      try {
        return JSON.parse(raw) as ApprovalDecision;
      } catch {
        return "timeout";
      }
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(POLL_INTERVAL_MS);
  }
}

export function createApprovalRegistry(redis: ApprovalRedis) {
  return {
    /**
     * Build an AgentBuilder.approvals handler bound to one stream run.
     * Each pending request is stored + surfaced via `append` and suspends
     * until the user decides (or the timeout fires).
     */
    createHandler(input: {
      userId: string;
      sessionId: string;
      streamId: string;
      append: (event: unknown) => Promise<void>;
      timeoutMs?: number;
    }): (request: ToolApprovalRequest) => Promise<ToolApprovalDecision> {
      const { userId, sessionId, streamId, append } = input;
      const timeoutMs = input.timeoutMs ?? APPROVAL_DEFAULT_TIMEOUT_MS;

      return async (request) => {
        const approvalId = randomUUID();
        const requestedAt = new Date().toISOString();
        const record: PendingApprovalRecord = {
          approvalId,
          userId,
          sessionId,
          streamId,
          toolName: request.toolName,
          args: request.rawArgs,
          ...(request.reason ? { reason: request.reason } : {}),
          status: "pending",
          requestedAt,
        };

        await redis.hset(APPROVAL_KEY(approvalId), record);
        await redis.expire(APPROVAL_KEY(approvalId), APPROVAL_TTL_SECONDS);

        await append({
          type: "tool_approval_request",
          approval: {
            id: approvalId,
            runId: request.run.runId,
            agentId: request.run.agentId,
            sessionId,
            toolName: request.toolName,
            ...(request.toolCallId ? { callId: request.toolCallId } : {}),
            internalCallId: request.internalCallId,
            args: request.rawArgs,
            status: "pending",
            requestedAt,
            ...(request.reason ? { reason: request.reason } : {}),
          },
        });

        const decision = await waitForDecision(redis, approvalId, timeoutMs);

        const resolvedAt = new Date().toISOString();
        if (decision === "timeout") {
          await redis.hset(APPROVAL_KEY(approvalId), {
            status: "timed_out",
            resolvedAt,
          });
          await append({
            type: "tool_approval_result",
            approval: {
              id: approvalId,
              toolName: request.toolName,
              status: "timed_out",
              resolvedAt,
            },
          });
          return {
            approved: false,
            reason:
              "Web access request timed out; answer from available knowledge.",
          };
        }

        const status: ApprovalStatus = decision.approved
          ? "approved"
          : "rejected";
        await redis.hset(APPROVAL_KEY(approvalId), {
          status,
          resolvedAt,
          ...(decision.reason ? { decisionReason: decision.reason } : {}),
        });
        await append({
          type: "tool_approval_result",
          approval: {
            id: approvalId,
            toolName: request.toolName,
            status,
            resolvedAt,
            ...(decision.reason ? { reason: decision.reason } : {}),
          },
        });

        return decision.approved
          ? { approved: true }
          : {
              approved: false,
              reason: decision.reason ?? request.rejectMessage,
            };
      };
    },

    /** Resolve a pending approval (called by the decision route). */
    async publishDecision(
      approvalId: string,
      decision: { approved: boolean; reason?: string },
    ): Promise<void> {
      await redis.set(
        DECISION_KEY(approvalId),
        JSON.stringify({
          approved: decision.approved,
          ...(decision.reason ? { reason: decision.reason } : {}),
          decidedAt: new Date().toISOString(),
        } satisfies ApprovalDecision),
        "EX",
        DECISION_TTL_SECONDS,
      );
    },

    async getApproval(
      approvalId: string,
    ): Promise<PendingApprovalRecord | null> {
      const raw = await redis.hgetall(APPROVAL_KEY(approvalId));
      if (!raw || Object.keys(raw).length === 0) return null;
      const status = raw.status as ApprovalStatus;
      return {
        approvalId: raw.approvalId ?? approvalId,
        userId: raw.userId ?? "",
        sessionId: raw.sessionId ?? "",
        streamId: raw.streamId ?? "",
        toolName: raw.toolName ?? "",
        args: raw.args ?? "",
        ...(raw.reason ? { reason: raw.reason } : {}),
        status: status === "pending" || status === "approved" || status === "rejected" || status === "timed_out"
          ? status
          : "pending",
        requestedAt: raw.requestedAt ?? new Date(0).toISOString(),
      };
    },

    /** Forget a resolved/expired approval (called after a decision). */
    async removeApproval(approvalId: string): Promise<void> {
      await redis.del(APPROVAL_KEY(approvalId), DECISION_KEY(approvalId));
    },
  };
}

let registry: ReturnType<typeof createApprovalRegistry> | null = null;

/** Process-lifetime registry backed by the shared Redis client. */
export function getApprovalRegistry() {
  if (!registry) {
    registry = createApprovalRegistry(getRedis());
  }
  return registry;
}
