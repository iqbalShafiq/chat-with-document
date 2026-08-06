import { Hono } from "hono";
import {
  DEFAULT_COMPLETION_MODEL,
  DEFAULT_COMPLETION_PROVIDER,
  DEFAULT_REASONING_EFFORT,
  parseCompletionModel,
  parseReasoningEffort,
} from "@assingment/agent";
import { createEventStream } from "@anvia/server";
import type { Message as MessageType } from "@anvia/core/completion";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { loadEnrichedMemoryMessages } from "./enrich-memory-messages.js";
import {
  finalizeAssistantCitations,
  tapStreamComplete,
} from "./finalize-assistant-citations.js";
import { listSessionsPage } from "./session-list.js";
import { stripUserAttachments } from "./strip-user-attachments.js";
import {
  TruncateTargetNotFoundError,
  truncateSessionMemory,
  type TruncateMode,
} from "./truncate-memory.js";
import { tapAgentStreamUsage } from "../usage/tap-agent-usage.js";
import { tapProfileRefresh } from "../profiling/tap-profile-refresh.js";
import { buildChatRunInput } from "./build-run-input.js";
import { computeContextUsage } from "./context-usage.js";
import {
  ensureChatSession,
  getOrCreateEmptyChatSession,
  ProjectMembershipError,
  setChatSessionTitleIfEmpty,
  touchChatSession,
} from "./chat-session.js";

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
    const sessionId = requireSessionId(
      body.sessionId ?? body.metadata?.sessionId,
    );
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const messages = body.messages as MessageType[];
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      return c.json({ error: "messages are required" }, 400);
    }

    // model / reasoningEffort: omit → defaults; invalid non-empty → 400
    const modelRaw = body.model;
    const effortRaw = body.reasoningEffort;
    const model =
      modelRaw === undefined || modelRaw === null || modelRaw === ""
        ? DEFAULT_COMPLETION_MODEL
        : parseCompletionModel(modelRaw);
    if (!model) {
      return c.json(
        {
          error:
            "model must be one of: gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol",
        },
        400,
      );
    }
    const reasoningEffort =
      effortRaw === undefined || effortRaw === null || effortRaw === ""
        ? DEFAULT_REASONING_EFFORT
        : parseReasoningEffort(effortRaw);
    if (!reasoningEffort) {
      return c.json(
        { error: "reasoningEffort must be one of: low, medium, high" },
        400,
      );
    }

    // Membership from product table — never trust client projectId.
    const chatSession = await ensureChatSession({
      sessionId,
      userId: user.id,
      projectId: null,
    });
    const projectId = chatSession.projectId;
    await touchChatSession(user.id, sessionId);

    const promptMessage = stripUserAttachments(lastMessage);

    // Durable list title from first user prompt (no-op if already set).
    const titleSeed = extractUserTextForTitle(promptMessage);
    if (titleSeed) {
      void setChatSessionTitleIfEmpty({
        userId: user.id,
        sessionId,
        title: titleSeed,
      }).catch((error) => {
        console.error("[chat] set title failed", error);
      });
    }

    const runInput = await buildChatRunInput({
      sessionId,
      userId: user.id,
      model,
      reasoningEffort,
    });
    const agent = runInput.agent;

    const stream = agent
      .session(sessionId, { userId: user.id })
      .prompt(promptMessage)
      .withTrace({
        sessionId,
        userId: user.id,
        ...(projectId ? { projectId } : {}),
      })
      .stream();

    const auditedStream = tapAgentStreamUsage(stream, {
      userId: user.id,
      sessionId,
      provider: DEFAULT_COMPLETION_PROVIDER,
      model,
      reasoningEffort,
      agentId: "my-agent",
    });

    // After the client consumes the stream: dual-write citations metadata + Langfuse score.
    // Profile tap runs outermost so it enqueues the background refresh last.
    const tracedStream = tapProfileRefresh(
      tapStreamComplete(auditedStream, () =>
        finalizeAssistantCitations(sessionId, user.id),
      ),
      { userId: user.id, projectId },
    );

    return createEventStream(tracedStream, {
      format: "jsonl",
    });
  });
