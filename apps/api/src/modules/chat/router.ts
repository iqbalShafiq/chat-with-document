import { Hono } from "hono";
import { prisma } from "../../utils/prisma.js";
import { createPrismaMemoryStore } from "@anvia/memory-prisma";
import {
  buildDocumentCatalogInstruction,
  createAgent,
  createChunkSearchService,
  createCompletionModel,
  createDataAnalysisTools,
  createDocumentTools,
  DEFAULT_COMPLETION_MODEL,
  DEFAULT_COMPLETION_PROVIDER,
  DEFAULT_REASONING_EFFORT,
  parseCompletionModel,
  parseReasoningEffort,
  tracing,
} from "@assingment/agent";
import { createEventStream } from "@anvia/server";
import type { Message as MessageType } from "@anvia/core/completion";
import { listSessionDocuments } from "../documents/service.js";
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

export const chatRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/sessions", async (c) => {
    const user = c.get("user");
    const page = await listSessionsPage({
      userId: user.id,
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    return c.json(page);
  })
  .get("/", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const messages = await loadEnrichedMemoryMessages(sessionId, user.id);
    return c.json(messages);
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

    const promptMessage = stripUserAttachments(lastMessage);

    const prismaMemory = createPrismaMemoryStore(prisma);
    const sessionDocuments = await listSessionDocuments(sessionId, user.id);
    const catalogInstruction = buildDocumentCatalogInstruction(sessionDocuments);
    const hasActiveDocuments = sessionDocuments.length > 0;

    // Document tools only when the session has linked ready docs — avoids the
    // model re-searching unlinked files based on conversation memory.
    const documentTools = hasActiveDocuments
      ? createDocumentTools({
          sessionId,
          userId: user.id,
          prisma,
          searchService: createChunkSearchService(),
        })
      : [];

    const agent = createAgent({
      agentId: "my-agent",
      model: createCompletionModel(model),
      reasoningEffort,
      tracing: tracing,
      additionalInstructions: [catalogInstruction],
      additionalTools: [...createDataAnalysisTools(), ...documentTools],
      memory: prismaMemory,
    });

    const stream = agent
      .session(sessionId, { userId: user.id })
      .prompt(promptMessage)
      .withTrace({ sessionId, userId: user.id })
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
    const tracedStream = tapStreamComplete(auditedStream, () =>
      finalizeAssistantCitations(sessionId, user.id),
    );

    return createEventStream(tracedStream, {
      format: "jsonl",
    });
  });
