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
export const CLARIFICATION_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const GRANT_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const OVERRIDE_TTL_SECONDS = 5 * 60;
const APPROVAL_TTL_SECONDS = 15 * 60;
const DECISION_TTL_SECONDS = 5 * 60;
const POLL_INTERVAL_MS = 500;

const APPROVAL_KEY = (approvalId: string) => `chat-approval:${approvalId}`;
const DECISION_KEY = (approvalId: string) =>
  `chat-approval:${approvalId}:decision`;
const GRANT_KEY = (sessionId: string, toolName: string) =>
  `chat-tool-grant:${sessionId}:${toolName}`;
const OVERRIDE_KEY = (sessionId: string, toolName: string) =>
  `chat-tool-override:${sessionId}:${toolName}`;
const CLARIFICATION_KEY = (id: string) => `chat-clarification:${id}`;
const CLARIFICATION_DECISION_KEY = (id: string) =>
  `chat-clarification:${id}:decision`;

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

export type ClarificationQuestion = {
  id: string;
  question: string;
  type: "single_choice" | "multiple_choice" | "free_text";
  options?: Array<{ id: string; label: string; recommended?: boolean }>;
  optional?: boolean;
  placeholder?: string;
};

export type ClarificationRequest = {
  title?: string;
  questions: ClarificationQuestion[];
};

export type ClarificationResponse = {
  answers: Record<string, string | string[]>;
  skipped: string[];
  timedOut: boolean;
};

type ClarificationStatus = "pending" | "answered" | "timed_out";

type ClarificationRecord = {
  id: string;
  userId: string;
  sessionId: string;
  streamId: string;
  title?: string;
  questions: ClarificationQuestion[];
  status: ClarificationStatus;
  requestedAt: string;
};

type ClarificationDecision = {
  answers?: unknown;
  skipped?: unknown;
};

/** Narrow surface used by the registry so tests can inject a fake. */
export type ApprovalRedis = Pick<
  Redis,
  "hset" | "hgetall" | "expire" | "get" | "getdel" | "set" | "del" | "keys"
>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDecision<T>(
  redis: ApprovalRedis,
  decisionKey: string,
  timeoutMs: number,
): Promise<T | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await redis.get(decisionKey);
    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Corrupt value — not a decision yet; drop it and keep polling.
        await redis.del(decisionKey);
      }
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(POLL_INTERVAL_MS);
  }
}

export function createApprovalRegistry(redis: ApprovalRedis) {
  /** Forget a resolved/expired approval (also called after a decision). */
  const removeApproval = async (approvalId: string): Promise<void> => {
    await redis.del(APPROVAL_KEY(approvalId), DECISION_KEY(approvalId));
  };

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

        const decision = await waitForDecision<ApprovalDecision>(
          redis,
          DECISION_KEY(approvalId),
          timeoutMs,
        );

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
          await removeApproval(approvalId);
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
        await removeApproval(approvalId);

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

    /** Make "Allow for session" sticky for a tool until the grant expires. */
    async grantTool(input: {
      sessionId: string;
      toolName: string;
    }): Promise<void> {
      await redis.set(
        GRANT_KEY(input.sessionId, input.toolName),
        JSON.stringify({ grantedAt: new Date().toISOString() }),
        "EX",
        GRANT_SESSION_TTL_SECONDS,
      );
    },

    async hasToolGrant(
      sessionId: string,
      toolName: string,
    ): Promise<boolean> {
      return (await redis.get(GRANT_KEY(sessionId, toolName))) !== null;
    },

    async revokeToolGrant(sessionId: string, toolName: string): Promise<void> {
      await redis.del(GRANT_KEY(sessionId, toolName));
    },

    /** Stage edited tool args the UI wants applied at approval time. */
    async setToolOverride(input: {
      sessionId: string;
      toolName: string;
      args: Record<string, unknown>;
    }): Promise<void> {
      await redis.set(
        OVERRIDE_KEY(input.sessionId, input.toolName),
        JSON.stringify(input.args),
        "EX",
        OVERRIDE_TTL_SECONDS,
      );
    },

    /** Fetch a staged override once, consuming it atomically. */
    async takeToolOverride(
      sessionId: string,
      toolName: string,
    ): Promise<Record<string, unknown> | null> {
      const key = OVERRIDE_KEY(sessionId, toolName);
      const raw = await redis.getdel(key);
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    },

    /**
     * Build a clarification requester bound to one stream run: stores the
     * request, surfaces it via `append`, and suspends until the user answers
     * (or the timeout fires). Powers the generic `request_clarification`
     * agent tool.
     */
    createClarificationRequester(input: {
      userId: string;
      sessionId: string;
      streamId: string;
      append: (event: unknown) => Promise<void>;
      timeoutMs?: number;
    }): (request: ClarificationRequest) => Promise<ClarificationResponse> {
      const { userId, sessionId, streamId, append } = input;
      const timeoutMs = input.timeoutMs ?? CLARIFICATION_DEFAULT_TIMEOUT_MS;

      return async (request) => {
        const id = randomUUID();
        const requestedAt = new Date().toISOString();
        const record: ClarificationRecord = {
          id,
          userId,
          sessionId,
          streamId,
          ...(request.title ? { title: request.title } : {}),
          questions: request.questions,
          status: "pending",
          requestedAt,
        };

        await redis.set(
          CLARIFICATION_KEY(id),
          JSON.stringify(record),
          "EX",
          APPROVAL_TTL_SECONDS,
        );

        await append({
          type: "clarification_request",
          clarification: {
            id,
            sessionId,
            ...(request.title ? { title: request.title } : {}),
            questions: request.questions,
            status: "pending",
            requestedAt,
          },
        });

        const decision = await waitForDecision<ClarificationDecision>(
          redis,
          CLARIFICATION_DECISION_KEY(id),
          timeoutMs,
        );

        const resolvedAt = new Date().toISOString();
        if (decision === "timeout") {
          await append({
            type: "clarification_response",
            clarification: { id, status: "timed_out", resolvedAt },
          });
          await redis.del(CLARIFICATION_KEY(id));
          return { answers: {}, skipped: [], timedOut: true };
        }

        const answers =
          typeof decision.answers === "object" &&
          decision.answers !== null &&
          !Array.isArray(decision.answers)
            ? (decision.answers as Record<string, string | string[]>)
            : {};
        const skipped = Array.isArray(decision.skipped)
          ? (decision.skipped as string[])
          : [];

        await append({
          type: "clarification_response",
          clarification: { id, status: "answered", resolvedAt },
        });
        await redis.del(CLARIFICATION_KEY(id));
        return { answers, skipped, timedOut: false };
      };
    },

    /** Resolve a pending clarification (called by the UI's answer route). */
    async publishClarificationResponse(
      id: string,
      response: { answers: Record<string, string | string[]>; skipped?: string[] },
    ): Promise<void> {
      await redis.set(
        CLARIFICATION_DECISION_KEY(id),
        JSON.stringify({
          ...response,
          decidedAt: new Date().toISOString(),
        }),
        "EX",
        DECISION_TTL_SECONDS,
      );
    },

    async getClarification(
      id: string,
    ): Promise<{ userId: string; status: ApprovalStatus } | null> {
      const raw = await redis.get(CLARIFICATION_KEY(id));
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (
          typeof parsed.userId !== "string" ||
          typeof parsed.status !== "string"
        ) {
          return null;
        }
        const status: ApprovalStatus =
          parsed.status === "pending" ||
          parsed.status === "approved" ||
          parsed.status === "rejected" ||
          parsed.status === "timed_out"
            ? parsed.status
            : "pending";
        return { userId: parsed.userId, status };
      } catch {
        return null;
      }
    },

    /** Forget a resolved/expired approval (called after a decision). */
    removeApproval,

    /**
     * Pending approvals for a running stream. Used by the chat resume route
     * to re-emit the approval request as a NEW event: the resume cursor only
     * replays events after the last consumed id, so the original request
     * (already consumed by the previous page) would never reach the UI again.
     */
    async listPendingApprovals(
      streamId: string,
    ): Promise<PendingApprovalRecord[]> {
      const keys = await redis.keys(APPROVAL_KEY("*"));
      const records: PendingApprovalRecord[] = [];
      for (const key of keys) {
        const raw = await redis.hgetall(key);
        if (!raw || Object.keys(raw).length === 0) continue;
        if (raw.streamId !== streamId || raw.status !== "pending") continue;
        records.push({
          approvalId: raw.approvalId ?? key.slice(APPROVAL_KEY("").length),
          userId: raw.userId ?? "",
          sessionId: raw.sessionId ?? "",
          streamId: raw.streamId ?? "",
          toolName: raw.toolName ?? "",
          args: raw.args ?? "",
          ...(raw.reason ? { reason: raw.reason } : {}),
          status: "pending",
          requestedAt: raw.requestedAt ?? new Date(0).toISOString(),
        });
      }
      return records;
    },

    /**
     * Pending clarifications for a running stream — same re-emit rationale
     * as listPendingApprovals.
     */
    async listPendingClarifications(
      streamId: string,
    ): Promise<ClarificationRecord[]> {
      const keys = await redis.keys(CLARIFICATION_KEY("*"));
      const records: ClarificationRecord[] = [];
      for (const key of keys) {
        const raw = await redis.get(key);
        if (raw === null) continue;
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed.streamId !== streamId || parsed.status !== "pending") {
            continue;
          }
          records.push({
            id: typeof parsed.id === "string" ? parsed.id : "",
            userId: typeof parsed.userId === "string" ? parsed.userId : "",
            sessionId:
              typeof parsed.sessionId === "string" ? parsed.sessionId : "",
            streamId:
              typeof parsed.streamId === "string" ? parsed.streamId : "",
            ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
            questions: Array.isArray(parsed.questions)
              ? (parsed.questions as ClarificationQuestion[])
              : [],
            status: parsed.status === "pending" ? "pending" : "answered",
            requestedAt:
              typeof parsed.requestedAt === "string"
                ? parsed.requestedAt
                : new Date(0).toISOString(),
          });
        } catch {
          // skip corrupt records
        }
      }
      return records;
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
