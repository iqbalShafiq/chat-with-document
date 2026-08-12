import { Hono } from "hono";
import { DEFAULT_COMPLETION_MODEL } from "@assingment/agent";
import { createEventStream, resumeStreamEvents } from "@anvia/server";
import type { Message as MessageType } from "@anvia/core/completion";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { findActiveModel } from "../models/service.js";
import {
  ACTIVE_RUN_KEY,
  enqueueChatRun,
  releaseActiveRun,
  tryAcquireActiveRun,
} from "./run-queue.js";
import { loadEnrichedMemoryMessages } from "./enrich-memory-messages.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";
import { prisma } from "../../utils/prisma.js";
import { listSessionsPage, markChatSessionRead } from "./session-list.js";
import { stripUserAttachments } from "./strip-user-attachments.js";
import {
  getApprovalRegistry,
} from "./approval-registry.js";
import { getContext7McpServer, isContext7Configured } from "../../lib/context7-server.js";
import {
  imageGenerationConfig,
  webSearchConfig,
} from "./build-run-input.js";
import { parseImageGenSettings } from "./image-gen-settings.js";
import { parseClarificationResponseBody } from "./clarification-body.js";
import {
  TruncateTargetNotFoundError,
  truncateSessionMemory,
  type TruncateMode,
} from "./truncate-memory.js";
import { computeContextUsage } from "./context-usage.js";
import {
  ChatSessionNotFoundError,
  ensureChatSession,
  getOrCreateEmptyChatSession,
  normalizeSessionTitle,
  ProjectMembershipError,
  renameChatSession,
  setChatSessionTitleIfEmpty,
  touchChatSession,
} from "./chat-session.js";
import {
  deleteChatSession,
  SessionRunActiveError,
} from "./session-delete.js";
import {
  getContextSnippetStore,
  parseContextSnippetBody,
  ContextSnippetSessionNotFoundError,
  type ContextSnippetRecord,
} from "./context-snippets.js";

function toContextSnippetDto(snippet: ContextSnippetRecord) {
  return {
    id: snippet.id,
    text: snippet.text,
    sourceRole: snippet.sourceRole,
    createdAt: snippet.createdAt.toISOString(),
  };
}

function requireSessionId(value: unknown): string | null {
  if (typeof value === "string") {
    const sessionId = value.trim();
    return sessionId.length > 0 ? sessionId : null;
  }
  return null;
}

function parseTruncateMode(value: unknown): TruncateMode | null {
  return value === "include" || value === "exclude" ? value : null;
}

function parseBoolean(value: unknown): boolean {
  return value === true;
}

function extractUserTextForTitle(message: MessageType): string {
  if (message.role !== "user") return "";
  const parts = message.content
    .filter(
      (part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text.trim())
    .filter(Boolean);
  return parts.join(" ");
}

function parseResume(value: unknown): { streamId: string; after: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.streamId !== "string" || !record.streamId) return null;
  if (typeof record.after !== "number" || !Number.isInteger(record.after) || record.after < 0) return null;
  return { streamId: record.streamId, after: record.after };
}

async function* withStartTimeout<T>(
  source: AsyncIterable<T>,
  streamId: string,
  timeoutMs: number,
): AsyncGenerator<T> {
  const store = getStreamStore();
  const iterator = source[Symbol.asyncIterator]();
  let receivedAny = false;
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
  while (true) {
    const outcome = await Promise.race([
      iterator.next().then((result) => ({ kind: "next" as const, result })),
      receivedAny ? new Promise<never>(() => {}) : timer,
    ]);
    if (outcome === "timeout") {
      await store.close({ streamId, status: "error" }).catch(() => {});
      // Let the underlying source observe the closed stream and end.
      const ended = await iterator.next().catch(() => ({ done: true as const }));
      if (ended.done) break;
      continue;
    }
    const { result } = outcome;
    if (result.done) break;
    receivedAny = true;
    yield result.value;
  }
}

export const chatRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/sessions", async (c) => {
    const user = c.get("user");
    const projectIdRaw = c.req.query("projectId");
    // Default: standalone only. Pass projectId to list that project's chats.
    const projectId =
      projectIdRaw && projectIdRaw.trim() ? projectIdRaw.trim() : null;

    const page = await listSessionsPage({
      userId: user.id,
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
      projectId,
    });
    return c.json(page);
  })
  .post("/sessions", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    const sessionId =
      requireSessionId(body?.sessionId) ?? crypto.randomUUID();
    const projectIdRaw = body?.projectId;
    const projectId =
      typeof projectIdRaw === "string" && projectIdRaw.trim()
        ? projectIdRaw.trim()
        : projectIdRaw === null
          ? null
          : undefined;

    try {
      const session = await ensureChatSession({
        sessionId,
        userId: user.id,
        projectId: projectId === undefined ? null : projectId,
      });
      return c.json(
        {
          sessionId: session.id,
          projectId: session.projectId,
          title: session.title,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
        },
        201,
      );
    } catch (error) {
      if (error instanceof ProjectMembershipError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      throw error;
    }
  })
  /**
   * One empty "New chat" draft per scope (standalone or project).
   * Reuses an existing empty session and prunes duplicate empties.
   */
  .post("/sessions/draft", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const projectIdRaw = body?.projectId;
    const projectId =
      typeof projectIdRaw === "string" && projectIdRaw.trim()
        ? projectIdRaw.trim()
        : null;

    try {
      const session = await getOrCreateEmptyChatSession({
        userId: user.id,
        projectId,
      });
      return c.json({
        sessionId: session.id,
        projectId: session.projectId,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof ProjectMembershipError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      throw error;
    }
  })
  .patch("/sessions/:id", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const title = typeof body?.title === "string" ? body.title : "";
    const normalized = normalizeSessionTitle(title);
    if (!normalized) {
      return c.json({ error: "title is required" }, 400);
    }

    try {
      const session = await renameChatSession({
        userId: user.id,
        sessionId: c.req.param("id"),
        title: normalized,
      });
      return c.json({
        sessionId: session.id,
        projectId: session.projectId,
        title: session.title,
        updatedAt: session.updatedAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof ChatSessionNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      throw error;
    }
  })
  .delete("/sessions/:id", async (c) => {
    const user = c.get("user");
    const confirmQuery = c.req.query("confirm");
    const confirm = confirmQuery === "true" || confirmQuery === "1";
    if (!confirm) {
      return c.json(
        {
          error: "Cascade delete requires confirm=true",
          code: "CONFIRM_REQUIRED",
        },
        400,
      );
    }

    try {
      const result = await deleteChatSession(user.id, c.req.param("id"));
      return c.json(result);
    } catch (error) {
      if (error instanceof ChatSessionNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      if (error instanceof SessionRunActiveError) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      throw error;
    }
  })
  .get("/", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    // Do not auto-create ChatSession on history load — stale localStorage ids
    // would stack empty "New chat" rows. Drafts are created via /sessions/draft
    // (or on first chat POST). Missing session → empty history is fine.
    const messages = await loadEnrichedMemoryMessages(sessionId, user.id);
    return c.json(messages);
  })
  .get("/context-usage", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

    const modelRaw = c.req.query("model");
    const model = modelRaw && modelRaw.trim() ? modelRaw.trim() : DEFAULT_COMPLETION_MODEL;
    const effortRaw = c.req.query("reasoningEffort");
    const reasoningEffort = effortRaw && effortRaw.trim() ? effortRaw.trim() : null;

    return c.json(
      await computeContextUsage({ sessionId, userId: user.id, model, reasoningEffort }),
    );
  })
  .get("/:sessionId/context-snippet", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("sessionId");
    if (!requireSessionId(sessionId)) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const snippet = await getContextSnippetStore().getSessionContextSnippet({
      userId: user.id,
      sessionId,
    });
    return c.json({ snippet: snippet ? toContextSnippetDto(snippet) : null });
  })
  .put("/:sessionId/context-snippet", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("sessionId");
    if (!requireSessionId(sessionId)) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = parseContextSnippetBody(body);
    if (!parsed) {
      return c.json(
        { error: "text (<= 2000 chars) and sourceRole (user|assistant) are required" },
        400,
      );
    }
    try {
      const snippet = await getContextSnippetStore().upsertContextSnippet({
        userId: user.id,
        sessionId,
        text: parsed.text,
        sourceRole: parsed.sourceRole,
      });
      return c.json({ snippet: toContextSnippetDto(snippet) }, 201);
    } catch (error) {
      if (error instanceof ContextSnippetSessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  })
  .delete("/context-snippet/:snippetId", async (c) => {
    const user = c.get("user");
    const snippetId = c.req.param("snippetId");
    const sessionId = c.req.query("sessionId");
    if (!snippetId || !sessionId) {
      return c.json({ error: "snippetId and sessionId are required" }, 400);
    }
    await getContextSnippetStore().removeContextSnippet({
      userId: user.id,
      snippetId,
    });
    return c.json({ ok: true });
  })
  .post("/sessions/mark-read", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const sessionId = requireSessionId(body?.sessionId);
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
    await markChatSessionRead({ userId: user.id, sessionId });
    return c.json({ ok: true });
  })
  .get("/runs", async (c) => {
    const user = c.get("user");
    const redis = getRedis();
    const store = getStreamStore();

    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await redis.scan(
        cursor,
        "MATCH",
        "rs-active:*",
        "COUNT",
        200,
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");

    const runs: Array<{
      sessionId: string;
      streamId: string;
      status: string;
      lastEventId: number;
    }> = [];
    for (const key of keys) {
      const sessionId = key.slice("rs-active:".length);
      if (!sessionId) continue;
      const streamId = await redis.get(key);
      if (!streamId) continue;
      const meta = await store.getMeta(streamId);
      if (!meta || meta.userId !== user.id) continue;
      const state = await store.status({ streamId });
      if (state.status !== "running") continue;
      runs.push({
        sessionId,
        streamId,
        status: state.status,
        lastEventId: state.lastEventId,
      });
    }
    return c.json({ runs });
  })
  .post("/truncate", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json()) as Record<string, unknown>;
    const sessionId = requireSessionId(body.sessionId);
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const mode = parseTruncateMode(body.mode);
    if (!mode) {
      return c.json({ error: 'mode must be "include" or "exclude"' }, 400);
    }

    const memoryPosition =
      typeof body.memoryPosition === "number" &&
      Number.isInteger(body.memoryPosition)
        ? body.memoryPosition
        : undefined;
    const clientMessageId =
      typeof body.clientMessageId === "string" &&
      body.clientMessageId.trim().length > 0
        ? body.clientMessageId.trim()
        : undefined;

    if (memoryPosition === undefined && clientMessageId === undefined) {
      return c.json(
        {
          error: "memoryPosition or clientMessageId is required",
        },
        400,
      );
    }

    try {
      const result = await truncateSessionMemory({
        sessionId,
        userId: user.id,
        mode,
        memoryPosition,
        clientMessageId,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof TruncateTargetNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      throw error;
    }
  })
  .post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.json();
    const sessionId = requireSessionId(body.sessionId ?? body.metadata?.sessionId);
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

    const resume = parseResume(body.resume);   // { streamId, after } | null
    const store = getStreamStore();

    if (resume) {
      const meta = await store.getMeta(resume.streamId);
      if (!meta || meta.userId !== user.id || meta.sessionId !== sessionId) {
        return c.json({ error: "stream not found", code: "STREAM_NOT_FOUND" }, 404);
      }
      // Rejoin recovery: a resuming client only receives events AFTER the
      // resume cursor, so a pending human-approval/clarification request
      // (already consumed by the previous page) would never re-render. Re-emit
      // pending requests as fresh events so the UI shows the card again and
      // the decision key still matches the original poller.
      const registry = getApprovalRegistry();
      try {
        const pendingApprovals = await registry.listPendingApprovals(resume.streamId);
        for (const approval of pendingApprovals) {
          await store.append({
            streamId: resume.streamId,
            event: {
              type: "tool_approval_request",
              approval: {
                id: approval.approvalId,
                sessionId: meta.sessionId,
                toolName: approval.toolName,
                args: approval.args,
                status: "pending",
                requestedAt: approval.requestedAt,
                ...(approval.reason ? { reason: approval.reason } : {}),
              },
            },
          });
        }
        const pendingClarifications = await registry.listPendingClarifications(resume.streamId);
        for (const clarification of pendingClarifications) {
          await store.append({
            streamId: resume.streamId,
            event: {
              type: "clarification_request",
              clarification: {
                id: clarification.id,
                sessionId: meta.sessionId,
                ...(clarification.title ? { title: clarification.title } : {}),
                questions: clarification.questions,
                status: "pending",
                requestedAt: clarification.requestedAt,
              },
            },
          });
        }
      } catch (error) {
        // Best-effort: the stream may have just ended; the normal replay
        // below still works for message events.
        console.error("[chat] resume re-emit failed", error);
      }
      const events = resumeStreamEvents({ id: resume.streamId, after: resume.after, store });
      return createEventStream(events, { format: "jsonl" });
    }

    // New run
    const modelRaw = body.model;
    const model = modelRaw && typeof modelRaw === "string" && modelRaw.trim()
      ? modelRaw.trim()
      : DEFAULT_COMPLETION_MODEL;
    const modelInfo = await findActiveModel(model);
    if (!modelInfo) return c.json({ error: `unknown model: ${model}` }, 400);

    const webSearchEnabled = parseBoolean(body.webSearchEnabled);
    const imageGenerationEnabled = parseBoolean(body.imageGenerationEnabled);
    const imageGenSettings = parseImageGenSettings(body.imageGenSettings);

    const effortRaw = body.reasoningEffort;
    let reasoningEffort: string | null = null;
    if (effortRaw && typeof effortRaw === "string" && effortRaw.trim()) {
      if (!modelInfo.reasoningEfforts.includes(effortRaw)) {
        return c.json({ error: `model ${model} does not support reasoning effort: ${effortRaw}` }, 400);
      }
      reasoningEffort = effortRaw;
    }

    const messages = body.messages as MessageType[];
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return c.json({ error: "messages are required" }, 400);

    const chatSession = await ensureChatSession({ sessionId, userId: user.id, projectId: null });
    await touchChatSession(user.id, sessionId);

    const promptMessage = stripUserAttachments(lastMessage);
    const titleSeed = extractUserTextForTitle(promptMessage);
    if (titleSeed) {
      void setChatSessionTitleIfEmpty({ userId: user.id, sessionId, title: titleSeed }).catch((error) => {
        console.error("[chat] set title failed", error);
      });
    }

    const streamId = crypto.randomUUID();
    const acquired = await tryAcquireActiveRun(sessionId, streamId, 2 * 60 * 60);
    if (!acquired) {
      return c.json({ error: "Session is already processing in another tab", code: "RUN_ACTIVE" }, 409);
    }

    try {
      await store.openWithMeta({ streamId }, {
        userId: user.id, sessionId, modelId: model, reasoningEffort,
      });
    } catch (error) {
      await releaseActiveRun(sessionId, streamId);
      throw error;
    }

    await enqueueChatRun(`chat:${streamId}`, {
      streamId, sessionId, userId: user.id, model, reasoningEffort,
      webSearchEnabled, imageGenerationEnabled, imageGenSettings,
      promptMessage, createdAt: new Date().toISOString(),
    });

    const events = withStartTimeout(
      resumeStreamEvents({ id: streamId, after: 0, store }),
      streamId,
      30_000,
    );
    return createEventStream(events, { format: "jsonl" });
  })
  .get("/run-status", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
    const store = getStreamStore();
    const streamId = await getRedis().get(ACTIVE_RUN_KEY(sessionId));
    if (!streamId) return c.json({ streamId: null, status: "idle", lastEventId: null });
    const state = await store.status({ streamId });
    return c.json({
      streamId,
      status: state.status === "running" ? "running" : state.status,
      lastEventId: state.lastEventId,
    });
  })
  .get("/session-state", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
    const scopeKey = createDefaultMemoryScopeKey(sessionId, user.id);
    const memorySession = await prisma.agentMemorySession.findUnique({
      where: { scopeKey },
      select: { id: true },
    });
    if (!memorySession) {
      return c.json({ messageCount: 0 });
    }
    const messageCount = await prisma.agentMemoryMessage.count({
      where: {
        memorySessionId: memorySession.id,
        role: { in: ["user", "assistant"] },
      },
    });
    return c.json({ messageCount });
  })
  .post("/stop", async (c) => {
    const user = c.get("user");
    const body = await c.req.json();
    const streamId = typeof body.streamId === "string" ? body.streamId : "";
    if (!streamId) return c.json({ error: "streamId is required" }, 400);
    const store = getStreamStore();
    const meta = await store.getMeta(streamId);
    if (!meta || meta.userId !== user.id) return c.json({ error: "stream not found" }, 404);
    // Stop flag ends the event stream; also unblock any human-input waiters
    // (approval / clarification) so the worker does not hang until timeout.
    await store.setStopFlag(streamId);
    const cancelled = await getApprovalRegistry()
      .cancelPendingForStream(streamId)
      .catch(() => ({ approvals: 0, clarifications: 0 }));
    return c.json({ ok: true, cancelled });
  })
  .get("/capabilities", async (c) => {
    const context7Server = await getContext7McpServer();
    return c.json({
      webSearchAvailable: webSearchConfig() !== null,
      imageGenerationAvailable: imageGenerationConfig() !== null,
      context7Available: isContext7Configured() && context7Server !== null,
    });
  })
  .post("/approvals/:approvalId/decision", async (c) => {
    const user = c.get("user");
    const approvalId = c.req.param("approvalId");
    if (!approvalId) return c.json({ error: "approvalId is required" }, 400);

    const body = (await c.req.json().catch(() => null)) as {
      approved?: unknown;
      reason?: unknown;
      grantScope?: unknown;
      overrideArgs?: unknown;
    } | null;
    if (body === null || typeof body.approved !== "boolean") {
      return c.json({ error: "approved (boolean) is required" }, 400);
    }

    const registry = getApprovalRegistry();
    const approval = await registry.getApproval(approvalId);
    if (!approval) {
      // Idempotent: the approval was already resolved and cleaned up (or TTL'd),
      // so a late decision is a no-op success — the client must not throw.
      return c.json({ ok: true, alreadyResolved: true });
    }
    if (approval.userId !== user.id) {
      return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403);
    }
    if (approval.status !== "pending") {
      // Idempotent: an already-resolved approval is a no-op.
      return c.json({ ok: true, alreadyResolved: true });
    }

    if (body.approved) {
      // "Allow for session" makes the tool skip its approval gate for the
      // rest of the session; the gate reads the grant on every call.
      if (body.grantScope === "session") {
        await registry.grantTool({
          sessionId: approval.sessionId,
          toolName: approval.toolName,
        });
      }
      // UI-edited tool args (e.g. image params) are staged once; the tool
      // consumes them atomically on its next call.
      if (
        body.overrideArgs &&
        typeof body.overrideArgs === "object" &&
        !Array.isArray(body.overrideArgs) &&
        Object.keys(body.overrideArgs).length > 0
      ) {
        await registry.setToolOverride({
          sessionId: approval.sessionId,
          toolName: approval.toolName,
          args: body.overrideArgs as Record<string, unknown>,
        });
      }
    }

    await registry.publishDecision(approvalId, {
      approved: body.approved,
      ...(typeof body.reason === "string" && body.reason.trim()
        ? { reason: body.reason.trim() }
        : {}),
    });
    return c.json({ ok: true });
  })
  .post("/clarifications/:id/response", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const registry = getApprovalRegistry();
    const record = await registry.getClarification(id);
    if (!record) {
      // Idempotent: the clarification was already answered, timed out, or
      // TTL'd — a late response is a no-op success.
      return c.json({ ok: true, alreadyResolved: true });
    }
    if (record.userId !== user.id) {
      return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403);
    }
    if (record.status !== "pending") {
      return c.json({ ok: true, alreadyResolved: true });
    }

    const body = await c.req.json().catch(() => null);
    const parsed = parseClarificationResponseBody(body);
    if (!parsed) {
      return c.json(
        {
          error:
            "answers (object of string | string[]) and optional skipped (string[]) are required",
        },
        400,
      );
    }

    await registry.publishClarificationResponse(id, parsed);
    return c.json({ ok: true });
  });
