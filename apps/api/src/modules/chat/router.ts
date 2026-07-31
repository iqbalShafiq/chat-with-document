import { Hono } from "hono";
import { prisma } from "../../utils/prisma.js";
import { createPrismaMemoryStore } from "@anvia/memory-prisma";
import {
  buildDocumentCatalogInstruction,
  createAgent,
  createChunkSearchService,
  createDataAnalysisTools,
  createDocumentTools,
  tracing,
} from "@assingment/agent";
import { createEventStream } from "@anvia/server";
import type { Message as MessageType } from "@anvia/core/completion";
import { listSessionDocuments } from "../documents/service.js";
import { loadEnrichedMemoryMessages } from "./enrich-memory-messages.js";
import { listSessionsPage } from "./session-list.js";
import { stripUserAttachments } from "./strip-user-attachments.js";
import {
  TruncateTargetNotFoundError,
  truncateSessionMemory,
  type TruncateMode,
} from "./truncate-memory.js";

function requireSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return sessionId.length > 0 ? sessionId : null;
}

function parseTruncateMode(value: unknown): TruncateMode | null {
  return value === "include" || value === "exclude" ? value : null;
}

export const chatRouter = new Hono()
  .get("/sessions", async (c) => {
    const page = await listSessionsPage({
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    return c.json(page);
  })
  .get("/", async (c) => {
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const messages = await loadEnrichedMemoryMessages(sessionId);
    return c.json(messages);
  })
  .post("/truncate", async (c) => {
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

    const promptMessage = stripUserAttachments(lastMessage);

    const prismaMemory = createPrismaMemoryStore(prisma);
    const sessionDocuments = await listSessionDocuments(sessionId);
    const catalogInstruction = buildDocumentCatalogInstruction(sessionDocuments);
    const searchService = createChunkSearchService();

    const agent = createAgent({
      agentId: "my-agent",
      tracing: tracing,
      additionalInstructions: [catalogInstruction],
      additionalTools: [
        ...createDataAnalysisTools(),
        ...createDocumentTools({
          sessionId,
          prisma,
          searchService,
        }),
      ],
      memory: prismaMemory,
    });

    const stream = agent
      .session(sessionId)
      .prompt(promptMessage)
      .withTrace({ sessionId })
      .stream();

    return createEventStream(stream, {
      format: "jsonl",
    });
  });
