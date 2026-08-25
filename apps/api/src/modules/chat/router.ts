import { Hono } from "hono";
import { z } from "zod";
import { resumeClientStreamResponse } from "@anvia/server";
import {
  assertAgentInteractionResponse,
  parseAgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type { Message as MessageType } from "@anvia/core/completion";
import { DEFAULT_COMPLETION_MODEL } from "@assingment/agent";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import {
  ACTIVE_RUN_KEY,
  ChatRunReconciliationError,
  enqueueChatResume,
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
  ChatRequestError,
  parseChatClientRequest,
} from "./client-request.js";
import {
  ChatMetadataSchema,
  ChatDataSchemas,
} from "./client-events.js";
import {
  getInteractionStore,
  InteractionClaimedError,
  InteractionExpiredError,
  InteractionOwnershipError,
  InteractionReplayedError,
  InteractionStoreError,
} from "./interaction-store.js";
import {
  getInteractionPolicyStore,
  interactionResponseFingerprint,
  InteractionPolicyConflictError,
  InteractionPolicyExpiredError,
  InteractionPolicyOwnershipError,
  InteractionPolicyReplayError,
  InteractionPolicyStoreError,
  InteractionPolicyUnavailableError,
} from "./interaction-policy-store.js";
import { resolveChatAgentRecipe } from "./build-run-input.js";
import { releaseChatAgentRecipeClaim } from "./run-recipe.js";
import { isContext7Configured } from "../../lib/context7-server.js";
import { resolveActiveDocuments } from "../documents/service.js";
import {
  imageGenerationConfig,
  webSearchConfig,
} from "./build-run-input.js";
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
import { getSteeringStore } from "./steering.js";
import { parseSteerBody } from "./steer-body.js";
import { getSteerSyncService, MAX_SYNC_IDS } from "./steer-sync.js";

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

function extractUserTextForTitle(message: MessageType): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  const parts = message.content
    .filter(
      (part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text.trim())
    .filter(Boolean);
  return parts.join(" ");
}

function requestErrorResponse(error: unknown): Response {
  if (error instanceof ChatRequestError) {
    return new Response(JSON.stringify({ error: error.message, code: error.code }), {
      status: error.code === "INVALID_REQUEST_METADATA" ? 422 : 400,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "client request is invalid", code: "INVALID_CLIENT_REQUEST" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

function streamResponse(streamId: string, after: number) {
  return resumeClientStreamResponse({
    streamId,
    after,
    store: getStreamStore() as never,
    metadataSchema: ChatMetadataSchema,
    dataSchemas: ChatDataSchemas,
  });
}

function safeInteractionError(error: unknown): Response {
  if (
    error instanceof InteractionOwnershipError ||
    error instanceof InteractionStoreError && (error.code === "not_found" || error.code === "ownership")
  ) {
    return new Response(JSON.stringify({ error: "interaction not found", code: "INTERACTION_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  if (error instanceof InteractionExpiredError) {
    return new Response(JSON.stringify({ error: "interaction expired", code: "INTERACTION_EXPIRED" }), { status: 409, headers: { "content-type": "application/json" } });
  }
  if (error instanceof InteractionReplayedError) {
    return new Response(JSON.stringify({ error: "interaction already replayed", code: "INTERACTION_REPLAYED" }), { status: 409, headers: { "content-type": "application/json" } });
  }
  if (error instanceof InteractionClaimedError) {
    return new Response(JSON.stringify({ error: "interaction is already being handled", code: "INTERACTION_CLAIMED" }), { status: 409, headers: { "content-type": "application/json" } });
  }
  if (error instanceof InteractionStoreError && (error.code === "type" || error.code === "claim_mismatch" || error.code === "conflict")) {
    return new Response(JSON.stringify({ error: "interaction response is invalid", code: "INTERACTION_RESPONSE_INVALID" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "interaction could not be processed", code: "INTERACTION_PROCESSING_ERROR" }), { status: 500, headers: { "content-type": "application/json" } });
}

function safeInteractionPolicyError(error: unknown, maskTerminal = false): Response {
  if (
    error instanceof InteractionPolicyOwnershipError ||
    (error instanceof InteractionPolicyStoreError && error.code === "not_found")
  ) {
    return new Response(
      JSON.stringify({ error: "interaction not found", code: "INTERACTION_NOT_FOUND" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  if (error instanceof InteractionPolicyExpiredError) {
    if (maskTerminal) return new Response(JSON.stringify({ error: "interaction not found", code: "INTERACTION_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(
      JSON.stringify({ error: "interaction policy expired", code: "INTERACTION_EXPIRED" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (
    error instanceof InteractionPolicyConflictError ||
    error instanceof InteractionPolicyReplayError
  ) {
    if (maskTerminal && error instanceof InteractionPolicyReplayError) return new Response(JSON.stringify({ error: "interaction not found", code: "INTERACTION_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(
      JSON.stringify({
        error: "interaction policy conflicts with an existing stage",
        code: "INTERACTION_POLICY_CONFLICT",
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (error instanceof InteractionPolicyUnavailableError) {
    return new Response(
      JSON.stringify({
        error: "interaction policy is temporarily unavailable",
        code: "INTERACTION_POLICY_UNAVAILABLE",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ error: "interaction policy could not be staged", code: "INTERACTION_POLICY_ERROR" }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

const imageOverrideCommonSchema = {
  prompt: z.string().min(3).max(4_000).optional(),
  modelId: z.string().min(1).max(512),
  aspectRatio: z.string().min(1).max(512).optional(),
  quality: z.string().min(1).max(512).optional(),
  background: z.string().min(1).max(512).optional(),
};

/**
 * These schemas mirror the v1 image tool inputs. Stage input is not allowed
 * to be an arbitrary JSON object: the worker later merges it into an image
 * tool call and re-validates the complete arguments.
 */
const generateImageOverrideSchema = z
  .object({
    ...imageOverrideCommonSchema,
    n: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const editImageOverrideSchema = z
  .object({
    ...imageOverrideCommonSchema,
    referenceImageId: z.string().min(1).max(256).optional(),
  })
  .strict();

const SESSION_GRANTABLE_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "deep_research",
  "generate_image",
  "edit_image",
]);

const authoritativeImageCapabilitiesSchema = z
  .object({
    quality: z.array(z.string().min(1).max(512)).min(1).max(64).optional(),
    background: z.array(z.string().min(1).max(512)).min(1).max(64).optional(),
    aspectRatios: z.array(z.string().min(1).max(512)).min(1).max(64).optional(),
    resolutions: z.array(z.string().min(1).max(512)).min(1).max(64).optional(),
    sizes: z.array(z.string().min(1).max(512)).min(1).max(64).optional(),
    n: z.object({ min: z.number().int().min(1), max: z.number().int().min(1).max(100) }).strict().optional(),
  })
  .strict();

async function parseImageOverride(
  toolName: string,
  value: unknown,
): Promise<Record<string, unknown> | null> {
  let parsed: Record<string, unknown> | null = null;
  if (toolName === "generate_image") {
    const result = generateImageOverrideSchema.safeParse(value);
    parsed = result.success ? (result.data as Record<string, unknown>) : null;
  } else if (toolName === "edit_image") {
    const result = editImageOverrideSchema.safeParse(value);
    parsed = result.success ? (result.data as Record<string, unknown>) : null;
  }
  if (!parsed || typeof parsed.modelId !== "string") return null;

  const model = await prisma.chatModel.findFirst({
    where: { modelId: parsed.modelId, outputType: "image", isActive: true },
    select: { imageCapabilities: true },
  });
  const capabilities = authoritativeImageCapabilitiesSchema.safeParse(
    model?.imageCapabilities,
  );
  if (!capabilities.success) return null;
  const supported = capabilities.data;
  if (
    (parsed.aspectRatio !== undefined &&
      (!supported.aspectRatios || !supported.aspectRatios.includes(String(parsed.aspectRatio)))) ||
    (parsed.quality !== undefined &&
      (!supported.quality || !supported.quality.includes(String(parsed.quality)))) ||
    (parsed.background !== undefined &&
      (!supported.background || !supported.background.includes(String(parsed.background)))) ||
    (parsed.n !== undefined &&
      (!supported.n ||
        Number(parsed.n) < supported.n.min ||
        Number(parsed.n) > supported.n.max))
  ) {
    return null;
  }
  return parsed;
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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return requestErrorResponse(new ChatRequestError("INVALID_CLIENT_REQUEST", "client request is invalid"));
    }

    let parsed: ReturnType<typeof parseChatClientRequest>;
    try {
      parsed = parseChatClientRequest(body);
    } catch (error) {
      return requestErrorResponse(error);
    }

    const store = getStreamStore();
    if (parsed.kind === "resume") {
      const meta = await store.getMeta(parsed.cursor.streamId);
      if (!meta || meta.userId !== user.id || meta.sessionId !== parsed.metadata.sessionId) {
        return c.json({ error: "stream not found", code: "STREAM_NOT_FOUND" }, 404);
      }
      const status = await store.status({ streamId: parsed.cursor.streamId });
      if (status.status === "missing") return c.json({ error: "stream not found", code: "STREAM_NOT_FOUND" }, 404);
      if (parsed.cursor.after > status.lastEventId) {
        return c.json({ error: "resume cursor is invalid", code: "RESUME_CURSOR_INVALID" }, 409);
      }
      return streamResponse(parsed.cursor.streamId, parsed.cursor.after);
    }

    if (parsed.kind === "interaction_response") {
      const interactionStore = getInteractionStore();
      const sessionId = parsed.metadata.sessionId;
      const ownership = { userId: user.id, sessionId };
      let existing;
      try {
        existing = await interactionStore.get(parsed.interactionId, ownership);
      } catch (error) {
        return safeInteractionError(error);
      }
      if (!existing) return c.json({ error: "interaction not found", code: "INTERACTION_NOT_FOUND" }, 404);
      if (existing.state === "consumed") return safeInteractionError(new InteractionReplayedError(parsed.interactionId));
      if (existing.state === "expired") return safeInteractionError(new InteractionExpiredError(parsed.interactionId));
      if (existing.state === "claimed") return safeInteractionError(new InteractionClaimedError(parsed.interactionId));
      const sameDocuments = JSON.stringify([...existing.recipe.documents.ids].sort()) === JSON.stringify([...parsed.metadata.documentIds].sort());
      const sameFeatures = existing.recipe.features.webSearchEnabled === parsed.metadata.webSearchEnabled
        && existing.recipe.features.imageGenerationEnabled === parsed.metadata.imageGenerationEnabled
        && existing.recipe.features.deepResearchEnabled === parsed.metadata.deepResearchEnabled;
      const sameImageSettings = canonicalJson(existing.recipe.imageGenSettings) === canonicalJson(parsed.metadata.imageGenSettings);
      if (existing.recipe.model.id !== parsed.metadata.modelId || existing.recipe.model.reasoningEffort !== parsed.metadata.reasoningEffort || !sameDocuments || !sameFeatures || !sameImageSettings) {
        return c.json({ error: "interaction response metadata is invalid", code: "INTERACTION_RESPONSE_INVALID" }, 400);
      }
      try {
        // Validate the native response against the persisted request before
        // allocating a stream, acquiring the session lease, or claiming any
        // durable interaction state. The worker repeats this assertion at its
        // queue boundary; this early check closes the API side-effect gap.
        assertAgentInteractionResponse(existing.request, parsed.response);
      } catch {
        return c.json({ error: "interaction response is invalid", code: "INTERACTION_RESPONSE_INVALID" }, 400);
      }
      const streamId = crypto.randomUUID();
      const acquired = await tryAcquireActiveRun(sessionId, streamId, 2 * 60 * 60);
      if (!acquired) return c.json({ error: "Session is already processing in another tab", code: "RUN_ACTIVE" }, 409);
      let opened = false;
      try {
        await store.openWithMeta({ streamId }, {
          userId: existing.userId,
          sessionId: existing.sessionId,
          modelId: existing.recipe.model.id,
          reasoningEffort: existing.recipe.model.reasoningEffort,
        });
        opened = true;
        await enqueueChatResume(parsed.interactionId, {
          kind: "resume",
          streamId,
          sessionId: existing.sessionId,
          userId: existing.userId,
          recipe: existing.recipe,
          continuation: existing.continuation,
          response: parsed.response,
          sourceInteractionId: parsed.interactionId,
          createdAt: new Date().toISOString(),
        }, { interactionStore, ownership });
      } catch (error) {
        if (error instanceof Error && error.name === "ChatResumeReconciliationError") {
          return streamResponse(streamId, 0);
        }
        if (opened) await store.close({ streamId, status: "error" }).catch(() => {});
        await releaseActiveRun(sessionId, streamId).catch(() => {});
        return safeInteractionError(error);
      }
      return streamResponse(streamId, 0);
    }

    const { metadata, messages } = parsed;
    const lastMessage = messages.at(-1);
    if (!lastMessage) return c.json({ error: "messages are invalid", code: "INVALID_MESSAGE" }, 400);
    const promptMessage = stripUserAttachments(lastMessage);
    const streamId = crypto.randomUUID();
    let recipe;
    try {
      recipe = await resolveChatAgentRecipe({
        sessionId: metadata.sessionId,
        userId: user.id,
        model: metadata.modelId,
        reasoningEffort: metadata.reasoningEffort,
        promptMessage,
        webSearchEnabled: metadata.webSearchEnabled,
        imageGenerationEnabled: metadata.imageGenerationEnabled,
        deepResearchEnabled: metadata.deepResearchEnabled,
        imageGenSettings: metadata.imageGenSettings,
        traceId: streamId,
        streamId,
        consumeSingleUseContext: true,
      });
    } catch {
      return c.json({ error: "chat request is not authorized", code: "CHAT_REQUEST_NOT_AUTHORIZED" }, 404);
    }
    const requestedDocuments = [...metadata.documentIds].sort();
    const resolvedDocuments = [...recipe.documents.ids].sort();
    if (requestedDocuments.length !== resolvedDocuments.length || requestedDocuments.some((id, index) => id !== resolvedDocuments[index])) {
      await releaseChatAgentRecipeClaim(recipe).catch(() => {});
      return c.json({ error: "document selection is not authorized", code: "DOCUMENTS_NOT_AUTHORIZED" }, 404);
    }
    const acquired = await tryAcquireActiveRun(metadata.sessionId, streamId, 2 * 60 * 60);
    if (!acquired) {
      await releaseChatAgentRecipeClaim(recipe).catch(() => {});
      return c.json({ error: "Session is already processing in another tab", code: "RUN_ACTIVE" }, 409);
    }
    let opened = false;
    try {
      await store.openWithMeta({ streamId }, {
        userId: user.id,
        sessionId: metadata.sessionId,
        modelId: recipe.model.id,
        reasoningEffort: recipe.model.reasoningEffort,
      });
      opened = true;
      await enqueueChatRun(`chat:${streamId}`, {
        kind: "start",
        streamId,
        sessionId: metadata.sessionId,
        userId: user.id,
        recipe,
        prompt: promptMessage,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ChatRunReconciliationError) {
        // BullMQ accepted the job. Keep the stream and active lease alive so
        // worker execution and durable claim reconciliation remain coherent.
        return streamResponse(streamId, 0);
      }
      if (opened) await store.close({ streamId, status: "error" }).catch(() => {});
      await releaseActiveRun(metadata.sessionId, streamId).catch(() => {});
      if (!opened) await releaseChatAgentRecipeClaim(recipe).catch(() => {});
      return c.json({ error: "chat run could not be queued", code: "CHAT_RUN_QUEUE_ERROR" }, 503);
    }
    await touchChatSession(user.id, metadata.sessionId);
    const titleSeed = extractUserTextForTitle(promptMessage);
    if (titleSeed) {
      void setChatSessionTitleIfEmpty({ userId: user.id, sessionId: metadata.sessionId, title: titleSeed }).catch(() => {});
    }
    return streamResponse(streamId, 0);
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
    await store.setStopFlag(streamId);
    return c.json({ ok: true });
  })
  .post("/steer", async (c) => {
    const user = c.get("user");
    const body = await c.req.json().catch(() => null);
    const parsed = parseSteerBody(body);
    if (!parsed) {
      return c.json(
        {
          error:
            "sessionId and messages (1-20 of { clientMessageId, text, attachments?, contextSnippet? }) are required",
        },
        400,
      );
    }
    const streamId = await getRedis().get(ACTIVE_RUN_KEY(parsed.sessionId));
    if (!streamId) {
      return c.json(
        { error: "No active run for this session", code: "NO_ACTIVE_RUN" },
        409,
      );
    }
    const meta = await getStreamStore().getMeta(streamId);
    if (!meta || meta.userId !== user.id) {
      return c.json({ error: "stream not found" }, 404);
    }
    const steering = getSteeringStore();
    let queued = 0;
    for (const message of parsed.messages) {
      if (await steering.push(streamId, message)) {
        queued += 1;
      }
    }
    return c.json({ ok: true, streamId, queued });
  })
  .post("/queue/sync", async (c) => {
    const user = c.get("user");
    const body = await c.req.json().catch(() => null);
    const record =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const sessionId = record ? requireSessionId(record.sessionId) : null;
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const rawIds = record?.ids;
    if (
      !Array.isArray(rawIds) ||
      rawIds.length === 0 ||
      rawIds.length > MAX_SYNC_IDS ||
      rawIds.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 64,
      )
    ) {
      return c.json(
        { error: "ids must be an array of 1-50 strings (max 64 chars each)" },
        400,
      );
    }
    const appliedIds = await getSteerSyncService().findAppliedClientMessageIds({
      sessionId,
      userId: user.id,
      ids: rawIds as string[],
    });
    return c.json({ appliedIds });
  })
  .get("/capabilities", async (c) => {
    const sessionId = c.req.query("sessionId");
    let hasActiveDocuments = false;
    if (sessionId) {
      const session = await prisma.chatSession.findFirst({
        where: { id: sessionId, userId: c.get("user").id },
        select: { projectId: true },
      });
      hasActiveDocuments = (await resolveActiveDocuments({
        userId: c.get("user").id,
        sessionId,
        projectId: session?.projectId ?? null,
      })).length > 0;
    }
    return c.json({
      webSearchAvailable: webSearchConfig() !== null,
      deepResearchAvailable: webSearchConfig() !== null || hasActiveDocuments,
      imageGenerationAvailable: imageGenerationConfig() !== null,
      context7Configured: isContext7Configured(),
    });
  })
  .post("/interactions/:interactionId/stage", async (c) => {
    const user = c.get("user");
    const interactionId = c.req.param("interactionId");
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    const candidate = body as Record<string, unknown>;
    const keys = Object.keys(candidate);
    if (!keys.every((key) => key === "response" || key === "grantScope" || key === "overrideArgs") || !Object.hasOwn(candidate, "response")) {
      return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    let response;
    try {
      response = parseAgentInteractionResponse(candidate.response);
    } catch {
      return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    const interactionStore = getInteractionStore();
    let record;
    try {
      // The interaction record carries the server-owned session binding. The
      // owner-aware lookup establishes the authenticated user before a
      // terminal tombstone can be translated into a replay/expiry response;
      // sessionId is never accepted from the staging body.
      record = await interactionStore.getForUser(interactionId, user.id);
    } catch (error) {
      return safeInteractionError(error);
    }
    if (!record) return safeInteractionError(new InteractionStoreError("interaction not found", "not_found"));
    if (record.userId !== user.id) return safeInteractionError(new InteractionOwnershipError(interactionId));
    if (record.state !== "pending") {
      return c.json({ error: "interaction cannot be staged in its current state", code: "INTERACTION_STATE_CONFLICT" }, 409);
    }
    if (record.request.type !== "tool-approval" || response.type !== "tool-approval") {
      return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    try {
      assertAgentInteractionResponse(record.request, response);
    } catch {
      return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    if (!response.approved) {
      return c.json({ error: "only approved tool interactions can be staged", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    if (candidate.grantScope !== undefined && candidate.grantScope !== "session") {
      return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    if (candidate.grantScope === "session" && !SESSION_GRANTABLE_TOOLS.has(record.request.toolName)) {
      return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
    }
    let overrideArgs: Record<string, unknown> | undefined;
    if (candidate.overrideArgs !== undefined) {
      const parsedOverride = await parseImageOverride(record.request.toolName, candidate.overrideArgs);
      if (!parsedOverride) {
        return c.json({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }, 400);
      }
      overrideArgs = parsedOverride;
    }
    try {
      await getInteractionPolicyStore().stage({
        interactionId,
        userId: record.userId,
        sessionId: record.sessionId,
        toolName: record.request.toolName,
        responseFingerprint: interactionResponseFingerprint(response),
        ...(candidate.grantScope === "session" ? { grantScope: "session" as const } : {}),
        ...(overrideArgs ? { overrideArgs } : {}),
      });
    } catch (error) {
      return safeInteractionPolicyError(error, true);
    }
    return c.json({ ok: true });
  })
  ;
