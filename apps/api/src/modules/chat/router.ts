import { Hono } from "hono";
import { prisma } from "../../utils/prisma.js";
import { createPrismaMemoryStore } from "@anvia/memory-prisma";
import {
  createAgent,
  createDataAnalysisTool,
  tracing,
} from "@assingment/agent";
import { createEventStream } from "@anvia/server";

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

    const messages = body.messages;
    const lastMessage = messages[messages.length - 1];

    const prismaMemory = createPrismaMemoryStore(prisma);

    const agent = createAgent({
      agentId: "my-agent",
      tracing: tracing,
      additionalInstructions: [],
      additionalTools: createDataAnalysisTool(),
      memory: prismaMemory,
    });

    const stream = agent
      .session(sessionId)
      .prompt(lastMessage)
      .withTrace({ sessionId })
      .stream();

    return createEventStream(stream, {
      format: "jsonl",
    });
  });
