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
import { listSessionsPage } from "./session-list.js";
import { stripUserAttachments } from "./strip-user-attachments.js";

function requireSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return sessionId.length > 0 ? sessionId : null;
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
