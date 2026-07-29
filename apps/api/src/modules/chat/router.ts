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
import { stripUserAttachments } from "./strip-user-attachments.js";
import { sanitizeMemoryMessages } from "./sanitize-memory-messages.js";

function requireSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return sessionId.length > 0 ? sessionId : null;
}

export const chatRouter = new Hono()
  .get("/sessions", async (c) => {
    const rows = await prisma.agentMemorySession.findMany({
      select: { sessionId: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });

    const seen = new Set<string>();
    const sessionIds: string[] = [];
    for (const row of rows) {
      if (seen.has(row.sessionId)) continue;
      seen.add(row.sessionId);
      sessionIds.push(row.sessionId);
    }

    return c.json(sessionIds);
  })
  .get("/", async (c) => {
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const prismaMemory = createPrismaMemoryStore(prisma);
    const messages = await prismaMemory.load({
      sessionId,
    });

    return c.json(messages);
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

    const baseMemory = createPrismaMemoryStore(prisma);
    const prismaMemory = Object.create(baseMemory) as typeof baseMemory;
    prismaMemory.load = async (context: Parameters<typeof baseMemory.load>[0]) => {
      const loaded = await baseMemory.load(context);
      return sanitizeMemoryMessages(loaded as MessageType[]);
    };
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
