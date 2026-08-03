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
import { resolveActiveDocuments } from "../documents/service.js";
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
import {
  ensureChatSession,
  ProjectMembershipError,
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

function buildProjectWorkspaceContext(input: {
  name: string;
  description: string | null;
}): string {
  const lines = [
    "Project workspace",
    `Name: ${input.name}`,
  ];
  if (input.description?.trim()) {
    lines.push(`Description: ${input.description.trim()}`);
  }
  lines.push(
    "You are answering inside this project workspace.",
    "Only use the active document catalog and tools for this chat.",
    "Do not assume access to other projects or the user's standalone library.",
  );
  return lines.join("\n");
}

export const chatRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/sessions", async (c) => {
    const user = c.get("user");
    const projectIdRaw = c.req.query("projectId");
    const standalone = c.req.query("standalone");

    let projectId: string | null | undefined;
    if (projectIdRaw && projectIdRaw.trim()) {
      projectId = projectIdRaw.trim();
    } else if (standalone === "0" || standalone === "false") {
      // Explicit non-filter not supported; default standalone
      projectId = null;
    } else {
      projectId = null;
    }

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
  .get("/", async (c) => {
    const user = c.get("user");
    const sessionId = requireSessionId(c.req.query("sessionId"));
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    // Ensure durable row exists for legacy sessions opened only via memory.
    await ensureChatSession({
      sessionId,
      userId: user.id,
      projectId: null,
    });

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

    // Membership from product table — never trust client projectId.
    const chatSession = await ensureChatSession({
      sessionId,
      userId: user.id,
      projectId: null,
    });
    const projectId = chatSession.projectId;
    await touchChatSession(user.id, sessionId);

    const promptMessage = stripUserAttachments(lastMessage);

    const prismaMemory = createPrismaMemoryStore(prisma);
    const sessionDocuments = await resolveActiveDocuments({
      userId: user.id,
      sessionId,
      projectId,
    });
    const catalogInstruction =
      buildDocumentCatalogInstruction(sessionDocuments);
    const hasActiveDocuments = sessionDocuments.length > 0;

    // Document tools only when the session has linked ready docs — avoids the
    // model re-searching unlinked files based on conversation memory.
    const documentTools = hasActiveDocuments
      ? createDocumentTools({
          sessionId,
          userId: user.id,
          projectId,
          prisma,
          searchService: createChunkSearchService(),
        })
      : [];

    let projectContext:
      | { text: string; id: string }
      | undefined;
    if (projectId) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, userId: user.id },
        select: { name: true, description: true },
      });
      if (project) {
        projectContext = {
          id: "project_workspace",
          text: buildProjectWorkspaceContext(project),
        };
      }
    }

    const agent = createAgent({
      agentId: "my-agent",
      model: createCompletionModel(model),
      reasoningEffort,
      tracing: tracing,
      additionalInstructions: [catalogInstruction],
      additionalContext: projectContext ? [projectContext] : [],
      additionalTools: [...createDataAnalysisTools(), ...documentTools],
      memory: prismaMemory,
    });

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
    const tracedStream = tapStreamComplete(auditedStream, () =>
      finalizeAssistantCitations(sessionId, user.id),
    );

    return createEventStream(tracedStream, {
      format: "jsonl",
    });
  });
