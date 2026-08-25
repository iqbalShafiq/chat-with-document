import {
  ISO_EXAMPLE,
  SESSION_ID_EXAMPLE,
  STREAM_ID_EXAMPLE,
  UUID_EXAMPLE,
  canonicalChatRequestSchema,
  chatMessageSchema,
  chatSessionSchema,
  contextSnippetSchema,
  exampleChatSession,
  interactionStagingRequestSchema,
  sessionListItemSchema,
} from "../components.js";
import {
  badRequest,
  bearerOrCookie,
  conflict,
  jsonResponse,
  jsonSchema,
  notFound,
  unauthorized,
} from "../helpers.js";

const sessionIdQuery = {
  name: "sessionId",
  in: "query",
  required: true,
  schema: { type: "string", format: "uuid" },
  example: SESSION_ID_EXAMPLE,
};

const sessionPageSchema = {
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: sessionListItemSchema },
    nextCursor: { type: "string", nullable: true },
  },
};

export const chatPaths = {
  "/api/chat/sessions": {
    get: {
      operationId: "listChatSessions",
      tags: ["Chat"],
      summary: "List chat sessions",
      description:
        "Paginated sessions owned by the current user, newest `updatedAt` first.\n\nWithout `projectId` only standalone chats are returned. Pass `projectId` to list that project's chats. Cursor format is `{isoUpdatedAt}|{sessionId}`. Default `limit` is 30, max 50.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "projectId",
          in: "query",
          required: false,
          schema: { type: "string", format: "uuid" },
          example: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          example: `${ISO_EXAMPLE}|${SESSION_ID_EXAMPLE}`,
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50 },
          example: 30,
        },
      ],
      responses: {
        "200": jsonResponse("A page of sessions.", sessionPageSchema, {
          default: {
            summary: "First page",
            value: {
              items: [
                {
                  sessionId: SESSION_ID_EXAMPLE,
                  updatedAt: ISO_EXAMPLE,
                  title: "Summarize the quarterly report",
                  projectId: null,
                  unread: false,
                },
              ],
              nextCursor: null,
            },
          },
        }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "createChatSession",
      tags: ["Chat"],
      summary: "Create or ensure a chat session",
      description:
        "Creates a `ChatSession` row (or returns the existing one) for `sessionId`. If `sessionId` is omitted a UUID is generated. `projectId` is optional; a non-null value must be a project the user owns.",
      security: bearerOrCookie,
      requestBody: {
        required: false,
        content: jsonSchema(
          {
            type: "object",
            properties: {
              sessionId: { type: "string", format: "uuid" },
              projectId: { type: ["string", "null"], format: "uuid" },
            },
          },
          {
            standalone: {
              summary: "Standalone chat",
              value: { sessionId: SESSION_ID_EXAMPLE },
            },
            project: {
              summary: "Inside a project",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                projectId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
              },
            },
          },
        ),
      },
      responses: {
        "201": jsonResponse("Session created or already existed.", chatSessionSchema, {
          default: { summary: "Created", value: exampleChatSession },
        }),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
      },
    },
  },
  "/api/chat/sessions/draft": {
    post: {
      operationId: "getOrCreateDraftSession",
      tags: ["Chat"],
      summary: "Reuse or create an empty draft chat",
      description:
        "Returns the single empty \"New chat\" draft for the given scope (standalone or project). Duplicate empty drafts for the same scope are pruned. Prefer this over inventing a `sessionId` client-side.",
      security: bearerOrCookie,
      requestBody: {
        required: false,
        content: jsonSchema(
          {
            type: "object",
            properties: {
              projectId: { type: ["string", "null"], format: "uuid" },
            },
          },
          {
            standalone: { summary: "Standalone draft", value: {} },
            project: {
              summary: "Project draft",
              value: { projectId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse("Draft session.", chatSessionSchema, {
          default: { summary: "Draft", value: exampleChatSession },
        }),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
      },
    },
  },
  "/api/chat/sessions/{id}": {
    patch: {
      operationId: "renameChatSession",
      tags: ["Chat"],
      summary: "Rename a chat session",
      description: "Sets a non-empty title (trimmed, max 120 characters).",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
      ],
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
          },
          {
            default: {
              summary: "New title",
              value: { title: "Q3 revenue notes" },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse("Renamed session.", chatSessionSchema, {
          default: {
            summary: "Renamed",
            value: { ...exampleChatSession, title: "Q3 revenue notes" },
          },
        }),
        "400": badRequest({ error: "title is required" }),
        "401": unauthorized,
        "404": notFound({ error: "Chat session not found", code: "CHAT_SESSION_NOT_FOUND" }),
      },
    },
    delete: {
      operationId: "deleteChatSession",
      tags: ["Chat"],
      summary: "Permanently delete a chat session",
      description:
        "Cascade-deletes the session and its memory. Requires `confirm=true` (query). Returns `409 SESSION_RUN_ACTIVE` if a run is still settling.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
        {
          name: "confirm",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["true", "1"] },
          example: "true",
        },
      ],
      responses: {
        "200": jsonResponse(
          "Session deleted.",
          {
            type: "object",
            required: ["deleted", "hadActiveRun"],
            properties: {
              deleted: { type: "boolean", const: true },
              hadActiveRun: { type: "boolean" },
            },
          },
          {
            default: {
              summary: "Deleted idle session",
              value: { deleted: true, hadActiveRun: false },
            },
          },
        ),
        "400": badRequest({
          error: "Cascade delete requires confirm=true",
          code: "CONFIRM_REQUIRED",
        }),
        "401": unauthorized,
        "404": notFound({ error: "Chat session not found", code: "CHAT_SESSION_NOT_FOUND" }),
        "409": conflict({
          error: "Session is still processing; try again in a moment",
          code: "SESSION_RUN_ACTIVE",
        }),
      },
    },
  },
  "/api/chat/sessions/mark-read": {
    post: {
      operationId: "markChatSessionRead",
      tags: ["Chat"],
      summary: "Mark a session as read",
      description: "Updates `lastReadAt` so the session no longer shows as unread.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["sessionId"],
            properties: { sessionId: { type: "string", format: "uuid" } },
          },
          { default: { summary: "Mark read", value: { sessionId: SESSION_ID_EXAMPLE } } },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Marked read.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          { default: { summary: "Ok", value: { ok: true } } },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/chat": {
    get: {
      operationId: "getChatHistory",
      tags: ["Chat"],
      summary: "Load message history",
      description:
        "Returns enriched memory messages for a session. Does **not** auto-create a `ChatSession` — a missing session yields an empty array. Use `POST /api/chat/sessions/draft` to create a draft first.",
      security: bearerOrCookie,
      parameters: [sessionIdQuery],
      responses: {
        "200": jsonResponse(
          "Message list (may be empty).",
          { type: "array", items: chatMessageSchema },
          {
            empty: { summary: "No history yet", value: [] },
            withMessages: {
              summary: "One turn",
              value: [
                {
                  role: "user",
                  content: [{ type: "text", text: "Summarize the PDF." }],
                },
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "Revenue grew 12% year over year in Q3.",
                    },
                  ],
                },
              ],
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "sendChatMessage",
      tags: ["Chat"],
      summary: "Send a message (JSONL stream) or resume a stream",
      description:
        "Accepts only the canonical Anvia v1 client stream request: a `messages` turn or a native `interaction_response`, each with strict product metadata. A top-level `resume` cursor on either branch is a pure subscription and never enqueues work.\n\nReturns protocol-v3 JSON Lines (`application/x-ndjson`) with a resumable stream. A session can only have one active run (`409 RUN_ACTIVE`). Queue follow-ups with `POST /api/chat/steer` while a run is live.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          canonicalChatRequestSchema,
          {
            send: {
              summary: "New user turn",
              value: {
                type: "messages",
                metadata: {
                  sessionId: SESSION_ID_EXAMPLE,
                  documentIds: [],
                  modelId: "deepseek/deepseek-v4-flash-0731",
                  reasoningEffort: "max",
                  webSearchEnabled: false,
                  imageGenerationEnabled: false,
                  deepResearchEnabled: false,
                  imageGenSettings: null,
                },
                messages: [
                  {
                    role: "user",
                    content: "What is 2 + 2?",
                  },
                ],
              },
            },
            interaction: {
              summary: "Respond to a native interaction",
              value: {
                type: "interaction_response",
                interactionId: "interaction_01",
                response: { type: "tool-approval", approved: true },
                metadata: {
                  sessionId: SESSION_ID_EXAMPLE,
                  documentIds: [],
                  modelId: "deepseek/deepseek-v4-flash-0731",
                  reasoningEffort: "max",
                  webSearchEnabled: false,
                  imageGenerationEnabled: false,
                  deepResearchEnabled: false,
                  imageGenSettings: null,
                },
              },
            },
          },
        ),
      },
      responses: {
        "200": {
          description:
            "Protocol-v3 JSONL event stream. Each line is a canonical Anvia client frame.",
          headers: {
            "x-anvia-stream-protocol": {
              required: true,
              schema: { type: "string", const: "anvia.client.v3" },
              description: "The exact Anvia client stream protocol negotiated by this API.",
            },
          },
          content: {
            "application/x-ndjson": {
              schema: { type: "string" },
              examples: {
                default: {
                  summary: "Protocol-v3 frames",
                  value: [
                    JSON.stringify({ type: "stream_start", protocol: "anvia.client.v3", streamId: STREAM_ID_EXAMPLE, eventId: 0, resumable: true }),
                    JSON.stringify({ type: "stream_end", streamId: STREAM_ID_EXAMPLE, eventId: 0, status: "completed" }),
                  ].join("\n"),
                },
              },
            },
          },
        },
        "400": badRequest({ error: "client request is invalid", code: "INVALID_CLIENT_REQUEST" }),
        "401": unauthorized,
        "404": notFound({ error: "stream or interaction not found", code: "STREAM_NOT_FOUND" }),
        "409": jsonResponse(
          "The stream cursor or interaction state conflicts with the current server state.",
          {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
          {
            cursor: { summary: "Cursor is ahead of the stream", value: { error: "resume cursor is invalid", code: "RESUME_CURSOR_INVALID" } },
            active: { summary: "Session already has a run", value: { error: "Session is already processing in another tab", code: "RUN_ACTIVE" } },
            replayed: { summary: "Interaction already consumed", value: { error: "interaction already replayed", code: "INTERACTION_REPLAYED" } },
            expired: { summary: "Interaction expired", value: { error: "interaction expired", code: "INTERACTION_EXPIRED" } },
            claimed: { summary: "Interaction is being handled", value: { error: "interaction is already being handled", code: "INTERACTION_CLAIMED" } },
            policy: { summary: "Policy stage conflict", value: { error: "interaction policy conflicts with an existing stage", code: "INTERACTION_POLICY_CONFLICT" } },
          },
        ),
        "422": badRequest({ error: "request metadata is invalid", code: "INVALID_REQUEST_METADATA" }),
        "503": jsonResponse(
          "The run queue is temporarily unavailable or requires reconciliation.",
          {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string", const: "CHAT_RUN_QUEUE_ERROR" } },
          },
          { unavailable: { summary: "Queue unavailable", value: { error: "chat run could not be queued", code: "CHAT_RUN_QUEUE_ERROR" } } },
        ),
      },
    },
  },
  "/api/chat/context-usage": {
    get: {
      operationId: "getContextUsage",
      tags: ["Chat"],
      summary: "Estimate context-window usage",
      description:
        "Token estimate for the current session against a model (and optional reasoning effort). Used by the UI compaction indicator.",
      security: bearerOrCookie,
      parameters: [
        sessionIdQuery,
        {
          name: "model",
          in: "query",
          required: false,
          schema: { type: "string" },
          example: "openai/gpt-5.6-luna",
        },
        {
          name: "reasoningEffort",
          in: "query",
          required: false,
          schema: { type: "string" },
          example: "high",
        },
      ],
      responses: {
        "200": jsonResponse(
          "Usage snapshot.",
          {
            type: "object",
            required: [
              "modelId",
              "modelLabel",
              "contextWindowTokens",
              "estimatedTokens",
              "ratio",
              "thresholdRatio",
              "targetRatio",
              "thresholdTokens",
              "targetTokens",
              "estimatedAt",
            ],
            properties: {
              modelId: { type: "string" },
              modelLabel: { type: "string" },
              contextWindowTokens: { type: "integer" },
              maxInputTokens: { type: ["integer", "null"] },
              maxOutputTokens: { type: ["integer", "null"] },
              estimatedTokens: { type: "integer" },
              ratio: { type: "number" },
              thresholdRatio: { type: "number" },
              targetRatio: { type: "number" },
              thresholdTokens: { type: "integer" },
              targetTokens: { type: "integer" },
              lastRunInputTokens: { type: ["integer", "null"] },
              reasoningEffort: { type: ["string", "null"] },
              estimatedAt: { type: "string", format: "date-time" },
            },
          },
          {
            default: {
              summary: "Healthy usage",
              value: {
                modelId: "openai/gpt-5.6-luna",
                modelLabel: "GPT 5.6 Luna",
                contextWindowTokens: 200000,
                maxInputTokens: null,
                maxOutputTokens: null,
                estimatedTokens: 4200,
                ratio: 0.021,
                thresholdRatio: 0.7,
                targetRatio: 0.3,
                thresholdTokens: 140000,
                targetTokens: 60000,
                lastRunInputTokens: 3800,
                reasoningEffort: null,
                estimatedAt: ISO_EXAMPLE,
              },
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/chat/{sessionId}/context-snippet": {
    get: {
      operationId: "getContextSnippet",
      tags: ["Chat"],
      summary: "Get the session context snippet",
      description:
        "Pinned snippet (max 2000 chars) injected into later turns. `snippet` is `null` when none is set.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "sessionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse(
          "Current snippet.",
          {
            type: "object",
            required: ["snippet"],
            properties: {
              snippet: { oneOf: [contextSnippetSchema, { type: "null" }] },
            },
          },
          {
            empty: { summary: "None set", value: { snippet: null } },
            present: {
              summary: "Pinned snippet",
              value: {
                snippet: {
                  id: UUID_EXAMPLE,
                  text: "Prefer concise bullet answers.",
                  sourceRole: "user",
                  createdAt: ISO_EXAMPLE,
                },
              },
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
    put: {
      operationId: "upsertContextSnippet",
      tags: ["Chat"],
      summary: "Create or replace the context snippet",
      description:
        "`text` must be 1–2000 characters. `sourceRole` is `user` or `assistant`.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "sessionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
      ],
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["text", "sourceRole"],
            properties: {
              text: { type: "string", minLength: 1, maxLength: 2000 },
              sourceRole: { type: "string", enum: ["user", "assistant"] },
            },
          },
          {
            default: {
              summary: "Pin a note",
              value: {
                text: "Prefer concise bullet answers.",
                sourceRole: "user",
              },
            },
          },
        ),
      },
      responses: {
        "201": jsonResponse(
          "Snippet stored.",
          {
            type: "object",
            required: ["snippet"],
            properties: { snippet: contextSnippetSchema },
          },
          {
            default: {
              summary: "Stored",
              value: {
                snippet: {
                  id: UUID_EXAMPLE,
                  text: "Prefer concise bullet answers.",
                  sourceRole: "user",
                  createdAt: ISO_EXAMPLE,
                },
              },
            },
          },
        ),
        "400": badRequest({
          error: "text (<= 2000 chars) and sourceRole (user|assistant) are required",
        }),
        "401": unauthorized,
        "404": notFound({ error: "session not found" }),
      },
    },
  },
  "/api/chat/context-snippet/{snippetId}": {
    delete: {
      operationId: "deleteContextSnippet",
      tags: ["Chat"],
      summary: "Remove a context snippet",
      description: "Deletes the snippet. Both `snippetId` (path) and `sessionId` (query) are required.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "snippetId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: UUID_EXAMPLE,
        },
        sessionIdQuery,
      ],
      responses: {
        "200": jsonResponse(
          "Removed.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          { default: { summary: "Removed", value: { ok: true } } },
        ),
        "400": badRequest({ error: "snippetId and sessionId are required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/chat/runs": {
    get: {
      operationId: "listActiveRuns",
      tags: ["Chat"],
      summary: "List the user's running streams",
      description:
        "Scans active resumable streams owned by the current user. Use this after app launch to reattach to a run that is still going.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Active runs.",
          {
            type: "object",
            required: ["runs"],
            properties: {
              runs: {
                type: "array",
                items: {
                  type: "object",
                  required: ["sessionId", "streamId", "status", "lastEventId"],
                  properties: {
                    sessionId: { type: "string" },
                    streamId: { type: "string" },
                    status: { type: "string" },
                    lastEventId: { type: "integer" },
                  },
                },
              },
            },
          },
          {
            idle: { summary: "Nothing running", value: { runs: [] } },
            running: {
              summary: "One live stream",
              value: {
                runs: [
                  {
                    sessionId: SESSION_ID_EXAMPLE,
                    streamId: STREAM_ID_EXAMPLE,
                    status: "running",
                    lastEventId: 18,
                  },
                ],
              },
            },
          },
        ),
        "401": unauthorized,
      },
    },
  },
  "/api/chat/run-status": {
    get: {
      operationId: "getRunStatus",
      tags: ["Chat"],
      summary: "Get the active run for one session",
      description: "Returns `idle` when no stream is locked for the session.",
      security: bearerOrCookie,
      parameters: [sessionIdQuery],
      responses: {
        "200": jsonResponse(
          "Run status.",
          {
            type: "object",
            required: ["streamId", "status", "lastEventId"],
            properties: {
              streamId: { type: ["string", "null"] },
              status: { type: "string" },
              lastEventId: { type: ["integer", "null"] },
            },
          },
          {
            idle: {
              summary: "Idle",
              value: { streamId: null, status: "idle", lastEventId: null },
            },
            running: {
              summary: "Running",
              value: {
                streamId: STREAM_ID_EXAMPLE,
                status: "running",
                lastEventId: 18,
              },
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/chat/session-state": {
    get: {
      operationId: "getSessionState",
      tags: ["Chat"],
      summary: "Count user/assistant messages in a session",
      description:
        "Lightweight freshness check before send. `messageCount` is 0 when the memory session does not exist yet.",
      security: bearerOrCookie,
      parameters: [sessionIdQuery],
      responses: {
        "200": jsonResponse(
          "Message count.",
          {
            type: "object",
            required: ["messageCount"],
            properties: { messageCount: { type: "integer" } },
          },
          {
            empty: { summary: "New session", value: { messageCount: 0 } },
            used: { summary: "Has history", value: { messageCount: 6 } },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/chat/truncate": {
    post: {
      operationId: "truncateChatMemory",
      tags: ["Chat"],
      summary: "Truncate session memory at a message",
      description:
        "`mode=include` keeps the target row and everything before it. `mode=exclude` keeps everything strictly before the target. Identify the target with `memoryPosition` and/or `clientMessageId`.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["sessionId", "mode"],
            properties: {
              sessionId: { type: "string", format: "uuid" },
              mode: { type: "string", enum: ["include", "exclude"] },
              memoryPosition: { type: "integer" },
              clientMessageId: { type: "string" },
            },
          },
          {
            include: {
              summary: "Keep through this message",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                mode: "include",
                memoryPosition: 4,
              },
            },
            exclude: {
              summary: "Drop from this client id",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                mode: "exclude",
                clientMessageId: "msg_client_01",
              },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Truncation result.",
          {
            type: "object",
            required: ["ok", "deleted", "keptThrough", "resolvedPosition"],
            properties: {
              ok: { type: "boolean" },
              deleted: { type: "integer" },
              keptThrough: { type: "integer" },
              resolvedPosition: { type: ["integer", "null"] },
            },
          },
          {
            default: {
              summary: "Truncated",
              value: {
                ok: true,
                deleted: 3,
                keptThrough: 4,
                resolvedPosition: 4,
              },
            },
          },
        ),
        "400": badRequest({ error: 'mode must be "include" or "exclude"' }),
        "401": unauthorized,
        "404": notFound({ error: "Target message not found", code: "TRUNCATE_TARGET_NOT_FOUND" }),
      },
    },
  },
  "/api/chat/stop": {
    post: {
      operationId: "stopChatRun",
      tags: ["Chat"],
      summary: "Stop an in-flight stream",
      description:
        "Sets the native Anvia stream stop flag for an owned stream. The response contains only `{ ok: true }`; durable native interactions are not converted into synthetic rejection answers.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["streamId"],
            properties: { streamId: { type: "string", format: "uuid" } },
          },
          { default: { summary: "Stop", value: { streamId: STREAM_ID_EXAMPLE } } },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Stop requested.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean", const: true } } },
          { default: { summary: "Stopped", value: { ok: true } } },
        ),
        "400": badRequest({ error: "streamId is required" }),
        "401": unauthorized,
        "404": notFound({ error: "stream not found" }),
      },
    },
  },
  "/api/chat/steer": {
    post: {
      operationId: "steerChatRun",
      tags: ["Chat"],
      summary: "Queue follow-up messages into the active run",
      description:
        "Pushes 1–20 follow-up messages onto the live run. The worker injects them through the native Anvia `AgentStream.steer()` boundary one per turn (FIFO). Returns `409 NO_ACTIVE_RUN` when the session is idle — the client should send a normal `POST /api/chat` instead.\n\nEach message needs `clientMessageId` + `text` (and optional `attachments`, `contextSnippet`).",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["sessionId", "messages"],
            properties: {
              sessionId: { type: "string", format: "uuid" },
              messages: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "object",
                  required: ["clientMessageId", "text"],
                  properties: {
                    clientMessageId: { type: "string", maxLength: 64 },
                    text: { type: "string", maxLength: 32000 },
                    attachments: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["mediaType", "data"],
                        properties: {
                          mediaType: { type: "string" },
                          data: { type: "string", description: "Base64 payload" },
                        },
                      },
                    },
                    contextSnippet: {
                      type: "object",
                      required: ["text", "sourceRole"],
                      properties: {
                        text: { type: "string", maxLength: 2000 },
                        sourceRole: { type: "string", enum: ["user", "assistant"] },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            default: {
              summary: "One follow-up",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                messages: [
                  {
                    clientMessageId: "followup_01",
                    text: "Also compare it to last quarter.",
                  },
                ],
              },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Queued onto the live run.",
          {
            type: "object",
            required: ["ok", "streamId", "queued"],
            properties: {
              ok: { type: "boolean" },
              streamId: { type: "string" },
              queued: { type: "integer" },
            },
          },
          {
            default: {
              summary: "Queued",
              value: { ok: true, streamId: STREAM_ID_EXAMPLE, queued: 1 },
            },
          },
        ),
        "400": badRequest({
          error:
            "sessionId and messages (1-20 of { clientMessageId, text, attachments?, contextSnippet? }) are required",
        }),
        "401": unauthorized,
        "404": notFound({ error: "stream not found" }),
        "409": conflict({
          error: "No active run for this session",
          code: "NO_ACTIVE_RUN",
        }),
      },
    },
  },
  "/api/chat/queue/sync": {
    post: {
      operationId: "syncChatQueue",
      tags: ["Chat"],
      summary: "Deduplicate a local follow-up queue",
      description:
        "Given 1–50 `clientMessageId`s, returns the subset that already landed in memory (`appliedIds`). Used after reload so the client can drop messages the worker already applied.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["sessionId", "ids"],
            properties: {
              sessionId: { type: "string", format: "uuid" },
              ids: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: { type: "string", maxLength: 64 },
              },
            },
          },
          {
            default: {
              summary: "Check two ids",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                ids: ["followup_01", "followup_02"],
              },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Ids already applied.",
          {
            type: "object",
            required: ["appliedIds"],
            properties: {
              appliedIds: { type: "array", items: { type: "string" } },
            },
          },
          {
            none: { summary: "None applied yet", value: { appliedIds: [] } },
            some: {
              summary: "One already in memory",
              value: { appliedIds: ["followup_01"] },
            },
          },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/chat/capabilities": {
    get: {
      operationId: "getChatCapabilities",
      tags: ["Chat"],
      summary: "Feature flags for this deployment",
      description:
        "Tells the client whether web search, Deep Research, and image generation are available, and whether Context7 MCP is configured. Pass sessionId to include document-only Deep Research availability.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Capability flags.",
          {
            type: "object",
            required: [
              "webSearchAvailable",
              "deepResearchAvailable",
              "imageGenerationAvailable",
              "context7Configured",
            ],
            properties: {
              webSearchAvailable: { type: "boolean" },
              deepResearchAvailable: { type: "boolean" },
              imageGenerationAvailable: { type: "boolean" },
              context7Configured: {
                type: "boolean",
                description:
                  "True when Context7 MCP is configured. Live connectivity is validated fail-closed by the chat worker when a run requests Context7.",
              },
            },
          },
          {
            default: {
              summary: "Typical local setup",
              value: {
                webSearchAvailable: true,
                deepResearchAvailable: true,
                imageGenerationAvailable: true,
                context7Configured: false,
              },
            },
          },
        ),
        "401": unauthorized,
      },
    },
  },
  "/api/chat/interactions/{interactionId}/stage": {
    post: {
      operationId: "stageChatInteraction",
      tags: ["Chat"],
      summary: "Stage interaction-scoped tool policy",
      description:
        "Validates and stages an interaction-scoped session grant or one-shot tool argument override. This route does not answer, publish, or unblock the native Anvia interaction; the canonical `POST /api/chat` interaction_response performs that transition.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "interactionId",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 256 },
          example: "interaction_01",
        },
      ],
      requestBody: {
        required: true,
        content: jsonSchema(
          interactionStagingRequestSchema,
          {
            allowOnce: {
              summary: "Stage an allow-once response",
              value: { response: { type: "tool-approval", approved: true } },
            },
            allowSession: {
              summary: "Stage a session grant",
              value: {
                response: { type: "tool-approval", approved: true },
                grantScope: "session",
              },
            },
            override: {
              summary: "Stage edited image args",
              value: {
                response: { type: "tool-approval", approved: true },
                overrideArgs: { aspectRatio: "16:9", quality: "high" },
              },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Interaction policy staged.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean", const: true } } },
          { default: { summary: "Staged", value: { ok: true } } },
        ),
        "400": badRequest({ error: "interaction staging request is invalid", code: "INTERACTION_STAGE_INVALID" }),
        "401": unauthorized,
        "404": notFound({ error: "interaction not found", code: "INTERACTION_NOT_FOUND" }),
        "409": jsonResponse(
          "The interaction is terminal or the requested policy conflicts with an existing stage.",
          {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
          {
            state: { summary: "Interaction is no longer pending", value: { error: "interaction cannot be staged in its current state", code: "INTERACTION_STATE_CONFLICT" } },
            policy: { summary: "Policy stage conflict", value: { error: "interaction policy conflicts with an existing stage", code: "INTERACTION_POLICY_CONFLICT" } },
          },
        ),
        "503": jsonResponse(
          "The durable interaction policy store is temporarily unavailable.",
          {
            type: "object",
            required: ["error", "code"],
            properties: {
              error: { type: "string" },
              code: { type: "string", const: "INTERACTION_POLICY_UNAVAILABLE" },
            },
          },
          {
            default: {
              summary: "Policy store unavailable",
              value: {
                error: "interaction policy is temporarily unavailable",
                code: "INTERACTION_POLICY_UNAVAILABLE",
              },
            },
          },
        ),
      },
    },
  },
};
