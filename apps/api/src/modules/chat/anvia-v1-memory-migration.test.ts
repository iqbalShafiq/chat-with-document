import { describe, expect, it } from "vitest";
import {
  auditMemoryStore,
  formatMigrationSummary,
  migrateMemoryStore,
  MemoryMigrationDriftError,
  normalizeMemoryMessage,
  normalizeMemoryMessageSequence,
} from "./anvia-v1-memory-migration.js";

describe("normalizeMemoryMessage", () => {
  it("leaves a strict v1 message byte-for-byte unchanged", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "already migrated" }],
      metadata: {
        clientMessageId: "client-1",
        citations: [{ id: 7, filename: "brief.pdf", pageIndex: 2 }],
      },
    } as const;

    const result = normalizeMemoryMessage(message);

    expect(result).toEqual({ status: "unchanged", message });
    expect(result.status === "unchanged" && result.message).toBe(message);
    expect(JSON.stringify(result)).toContain("already migrated");
  });

  it("converts legacy user image and document sources without dropping safe metadata", () => {
    const legacy = {
      role: "user",
      content: [
        { type: "text", text: "inspect these" },
        {
          type: "image",
          source: { type: "url", url: "https://cdn.example/image.png" },
          detail: "high",
        },
        {
          type: "document",
          source: {
            type: "url",
            url: "https://cdn.example/brief.pdf",
            mediaType: "application/pdf",
            filename: "brief.pdf",
          },
        },
      ],
      metadata: {
        clientMessageId: "client-legacy-1",
        citations: [{ id: 1, filename: "brief.pdf", pageIndex: 0 }],
      },
    };

    expect(normalizeMemoryMessage(legacy)).toEqual({
      status: "converted",
      message: {
        role: "user",
        content: [
          { type: "text", text: "inspect these" },
          {
            type: "image",
            image: { type: "url", url: "https://cdn.example/image.png" },
            detail: "high",
          },
          {
            type: "file",
            data: { type: "url", url: "https://cdn.example/brief.pdf" },
            mediaType: "application/pdf",
            filename: "brief.pdf",
          },
        ],
        metadata: {
          clientMessageId: "client-legacy-1",
          citations: [{ id: 1, filename: "brief.pdf", pageIndex: 0 }],
        },
      },
    });
  });

  it("converts legacy reasoning and tool calls while preserving call metadata", () => {
    const legacy = {
      role: "assistant",
      id: "assistant-1",
      content: [
        {
          type: "reasoning",
          id: "reasoning-1",
          text: "I should search.",
          content: [
            { type: "summary", text: "Search the document." },
            { type: "text", text: "Use the user's document." },
          ],
        },
        {
          type: "tool_call",
          id: "call-1",
          callId: "call-instance-1",
          function: { name: "search_docs", arguments: { query: "budget" } },
          signature: "sig-1",
        },
      ],
      metadata: { clientMessageId: "assistant-client-1" },
    };

    expect(normalizeMemoryMessage(legacy)).toEqual({
      status: "converted",
      message: {
        role: "assistant",
        id: "assistant-1",
        content: [
          {
            type: "reasoning",
            id: "reasoning-1",
            text: "I should search.",
            details: [
              { type: "summary", text: "Search the document." },
              { type: "text", text: "Use the user's document." },
            ],
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            callId: "call-instance-1",
            toolName: "search_docs",
            input: { query: "budget" },
            signature: "sig-1",
          },
        ],
        metadata: { clientMessageId: "assistant-client-1" },
      },
    });
  });

  it("preserves empty legacy text parts because v1 accepts empty text", () => {
    expect(
      normalizeMemoryMessage({
        role: "assistant",
        content: [
          { type: "text", text: "" },
          {
            type: "tool_call",
            id: "call-empty-text",
            function: { name: "search_docs", arguments: {} },
          },
        ],
      }),
    ).toEqual({
      status: "converted",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          {
            type: "tool-call",
            toolCallId: "call-empty-text",
            toolName: "search_docs",
            input: {},
          },
        ],
      },
    });
  });
});

describe("normalizeMemoryMessageSequence", () => {
  it("derives a legacy tool result name and pairing from one matching call", () => {
    const result = normalizeMemoryMessageSequence([
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            callId: "call-instance-1",
            function: { name: "search_docs", arguments: "{\"query\":\"budget\"}" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            id: "call-1",
            content: [
              { type: "text", text: "Found 2 pages." },
              { type: "image", data: "aGVsbG8=", mediaType: "image/png" },
            ],
          },
        ],
      },
    ]);

    expect(result).toEqual({
      status: "converted",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              callId: "call-instance-1",
              toolName: "search_docs",
              input: { query: "budget" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              callId: "call-instance-1",
              toolName: "search_docs",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Found 2 pages." },
                  {
                    type: "file",
                    data: { type: "data", data: "aGVsbG8=" },
                    mediaType: "image/png",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  });

  it("rejects an orphan legacy tool result instead of guessing its tool name", () => {
    expect(
      normalizeMemoryMessageSequence([
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              id: "missing-call",
              toolName: "search_docs",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      ]),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("orphan"),
    });
  });

  it("rejects ambiguous matching calls before converting a legacy tool result", () => {
    expect(
      normalizeMemoryMessageSequence([
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "duplicate-call",
              function: { name: "search_docs", arguments: {} },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "duplicate-call",
              function: { name: "search_web", arguments: {} },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              id: "duplicate-call",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      ]),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("ambiguous"),
    });
  });

  it("rejects invalid legacy tool arguments rather than changing their meaning", () => {
    expect(
      normalizeMemoryMessage({
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            function: { name: "search_docs", arguments: "not-json" },
          },
        ],
      }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("arguments"),
    });
  });
});

function fakeMigrationClient(input: {
  messages: Array<{ id: string; memorySessionId: string; position: number; message: unknown }>;
  errors: Array<{ id: string; memorySessionId: string; messages: unknown }>;
  beforeMessageFindUnique?: () => void;
  beforeErrorFindUnique?: () => void;
  beforeMessageUpdateMany?: (args: unknown) => void;
  beforeErrorUpdateMany?: (args: unknown) => void;
  onMessageFindMany?: (args: unknown, call: number) => void;
  onErrorFindMany?: (args: unknown, call: number) => void;
  sessionIds?: string[];
  onSessionFindMany?: (args: unknown, call: number) => void;
}) {
  const messageUpdates: unknown[] = [];
  const errorUpdates: unknown[] = [];
  const messageUpdateMany: unknown[] = [];
  const errorUpdateMany: unknown[] = [];
  const messageFindManyArgs: unknown[] = [];
  const errorFindManyArgs: unknown[] = [];
  const sessionFindManyArgs: unknown[] = [];
  const sessionRows = (input.sessionIds ?? [
    ...new Set([
      ...input.messages.map((row) => row.memorySessionId),
      ...input.errors.map((row) => row.memorySessionId),
    ]),
  ])
    .map((id) => ({ id }))
    .sort((left, right) => left.id.localeCompare(right.id));
  let transactionCount = 0;
  const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const page = <T extends { id: string }>(rows: T[], args: unknown): T[] => {
    const query = (args ?? {}) as {
      take?: number;
      skip?: number;
      cursor?: { id: string };
      where?: { memorySessionId?: string };
    };
    const scoped = query.where?.memorySessionId
      ? rows.filter((row) => (row as { memorySessionId?: string }).memorySessionId === query.where!.memorySessionId)
      : rows;
    const cursorIndex = query.cursor
      ? scoped.findIndex((row) => row.id === query.cursor!.id)
      : -1;
    const start = cursorIndex < 0 ? 0 : cursorIndex + (query.skip ?? 0);
    return scoped
      .slice(start, start + (query.take ?? rows.length))
      .map((row) => ({ ...row }));
  };
  const client = {
    agentMemorySession: {
      findMany: async (args: unknown) => {
        sessionFindManyArgs.push(args);
        input.onSessionFindMany?.(args, sessionFindManyArgs.length);
        return page(sessionRows, args);
      },
    },
    agentMemoryMessage: {
      findMany: async (args: unknown) => {
        messageFindManyArgs.push(args);
        input.onMessageFindMany?.(args, messageFindManyArgs.length);
        return page(input.messages, args);
      },
      findUnique: async (args: unknown) => {
        input.beforeMessageFindUnique?.();
        const id = (args as { where?: { id?: string } }).where?.id;
        const row = input.messages.find((item) => item.id === id);
        return row ? { message: row.message } : null;
      },
      update: async (args: unknown) => {
        messageUpdates.push(args);
        const update = args as {
          where: { id: string };
          data: { message: unknown };
        };
        const row = input.messages.find((item) => item.id === update.where.id);
        if (row) row.message = update.data.message;
      },
      updateMany: async (args: unknown) => {
        messageUpdateMany.push(args);
        input.beforeMessageUpdateMany?.(args);
        const update = args as {
          where: { id: string; message?: { equals: unknown } };
          data: { message: unknown };
        };
        const row = input.messages.find((item) => item.id === update.where.id);
        if (
          row &&
          update.where.message &&
          canonicalJson(row.message) === canonicalJson(update.where.message.equals)
        ) {
          row.message = update.data.message;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    agentMemoryError: {
      findMany: async (args: unknown) => {
        errorFindManyArgs.push(args);
        input.onErrorFindMany?.(args, errorFindManyArgs.length);
        return page(input.errors, args);
      },
      findUnique: async (args: unknown) => {
        input.beforeErrorFindUnique?.();
        const id = (args as { where?: { id?: string } }).where?.id;
        const row = input.errors.find((item) => item.id === id);
        return row ? { messages: row.messages } : null;
      },
      update: async (args: unknown) => {
        errorUpdates.push(args);
        const update = args as {
          where: { id: string };
          data: { messages: unknown };
        };
        const row = input.errors.find((item) => item.id === update.where.id);
        if (row) row.messages = update.data.messages;
      },
      updateMany: async (args: unknown) => {
        errorUpdateMany.push(args);
        input.beforeErrorUpdateMany?.(args);
        const update = args as {
          where: { id: string; messages?: { equals: unknown } };
          data: { messages: unknown };
        };
        const row = input.errors.find((item) => item.id === update.where.id);
        if (
          row &&
          update.where.messages &&
          canonicalJson(row.messages) === canonicalJson(update.where.messages.equals)
        ) {
          row.messages = update.data.messages;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    $transaction: async <T>(operation: (tx: any) => Promise<T>): Promise<T> => {
      transactionCount += 1;
      const messageSnapshot = input.messages.map((row) => ({ ...row }));
      const errorSnapshot = input.errors.map((row) => ({ ...row }));
      try {
        return await operation(client);
      } catch (error) {
        input.messages.splice(0, input.messages.length, ...messageSnapshot);
        input.errors.splice(0, input.errors.length, ...errorSnapshot);
        throw error;
      }
    },
    messageUpdates,
    errorUpdates,
    messageUpdateMany,
    errorUpdateMany,
    messageFindManyArgs,
    errorFindManyArgs,
    sessionFindManyArgs,
    get transactionCount() {
      return transactionCount;
    },
  };
  return client;
}

describe("auditMemoryStore", () => {
  it("audits message and failed-run rows without mutating the client", async () => {
    const client = fakeMigrationClient({
      messages: [
        {
          id: "message-1",
          memorySessionId: "memory-1",
          position: 1,
          message: { role: "user", content: "already v1" },
        },
        {
          id: "message-2",
          memorySessionId: "memory-1",
          position: 2,
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://cdn.example/image.png" },
              },
            ],
          },
        },
      ],
      errors: [
        {
          id: "error-1",
          memorySessionId: "memory-1",
          messages: [{ role: "user", content: "failed prompt" }],
        },
      ],
    });

    const report = await auditMemoryStore(client);

    expect(report).toMatchObject({
      blocked: false,
      messages: { total: 2, unchanged: 1, converted: 1, rejected: 0 },
      errors: { total: 1, unchanged: 1, converted: 0, rejected: 0 },
      pages: { messages: 1, errors: 1 },
    });
    expect(client.messageUpdates).toEqual([]);
    expect(client.errorUpdates).toEqual([]);
    expect(client.messageUpdateMany).toEqual([]);
    expect(client.errorUpdateMany).toEqual([]);
  });

  it("blocks write mode globally when any message or failed-run row is unconvertible", async () => {
    const client = fakeMigrationClient({
      messages: [
        {
          id: "message-1",
          memorySessionId: "memory-1",
          position: 1,
          message: {
            role: "tool",
            content: [
              {
                type: "tool_result",
                id: "orphan-call",
                content: [{ type: "text", text: "result" }],
              },
            ],
          },
        },
      ],
      errors: [],
    });

    const report = await migrateMemoryStore(client, { write: true });

    expect(report.blocked).toBe(true);
    expect(report.issues).toHaveLength(1);
    expect(client.messageUpdates).toEqual([]);
    expect(client.errorUpdates).toEqual([]);
  });

  it("audits bounded cursor pages globally before allowing any write", async () => {
    const client = fakeMigrationClient({
      messages: [
        {
          id: "message-1",
          memorySessionId: "memory-1",
          position: 1,
          message: { role: "user", content: "already v1" },
        },
        {
          id: "message-2",
          memorySessionId: "memory-1",
          position: 2,
          message: {
            role: "tool",
            content: [
              {
                type: "tool_result",
                id: "orphan-call",
                content: [{ type: "text", text: "late bad row" }],
              },
            ],
          },
        },
      ],
      errors: [],
    });

    const report = await migrateMemoryStore(client, {
      write: true,
      pageSize: 1,
    });

    expect(report).toMatchObject({
      blocked: true,
      pages: { messages: 3, errors: 1 },
    });
    expect(client.messageFindManyArgs).toHaveLength(3);
    expect(client.messageFindManyArgs[1]).toMatchObject({
      take: 1,
      skip: 1,
      cursor: { id: "message-1" },
    });
    expect(client.messageUpdates).toEqual([]);
    expect(client.errorUpdates).toEqual([]);
    expect(client.messageUpdateMany).toEqual([]);
    expect(client.errorUpdateMany).toEqual([]);
  });

  it("pages parent memory sessions and retains only one session body at a time", async () => {
    const client = fakeMigrationClient({
      sessionIds: ["memory-a", "memory-b", "memory-c"],
      messages: [
        ...["memory-a", "memory-b", "memory-c"].map((memorySessionId, index) => ({
          id: `message-${index}`,
          memorySessionId,
          position: 1,
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: `https://cdn.example/${memorySessionId}.png` },
              },
            ],
          },
        })),
      ],
      errors: [],
    });

    await migrateMemoryStore(client, { write: true, pageSize: 1 });

    expect(client.sessionFindManyArgs).toHaveLength(4);
    expect(client.sessionFindManyArgs[1]).toMatchObject({
      take: 1,
      skip: 1,
      cursor: { id: "memory-a" },
    });
    expect(client.messageUpdateMany).toHaveLength(3);
  });

  it("aborts a write when a row drifts after the audit read", async () => {
    const input: {
      messages: Array<{
        id: string;
        memorySessionId: string;
        position: number;
        message: unknown;
      }>;
      errors: Array<{ id: string; memorySessionId: string; messages: unknown }>;
      beforeMessageUpdateMany: () => void;
    } = {
      messages: [
        {
          id: "message-drift",
          memorySessionId: "memory-drift",
          position: 1,
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://cdn.example/image.png" },
              },
            ],
          },
        },
      ],
      errors: [],
      beforeMessageUpdateMany: () => {
        input.messages[0]!.message = {
          role: "user",
          content: "changed concurrently",
        };
      },
    };
    const client = fakeMigrationClient(input);

    await expect(
      migrateMemoryStore(client, { write: true, pageSize: 1 }),
    ).rejects.toMatchObject({
      name: "MemoryMigrationDriftError",
      table: "message",
      rowId: "message-drift",
    });
    expect(client.messageUpdateMany).toHaveLength(1);
  });

  it("uses an atomic JSON equality predicate instead of an unconditional update", async () => {
    const original = {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", url: "https://cdn.example/image.png" },
        },
      ],
      metadata: { first: 1, second: 2 },
    };
    const client = fakeMigrationClient({
      messages: [
        {
          id: "message-atomic",
          memorySessionId: "memory-atomic",
          position: 1,
          message: original,
        },
      ],
      errors: [],
    });

    await migrateMemoryStore(client, { write: true });

    expect(client.messageUpdateMany).toHaveLength(1);
    expect(client.messageUpdateMany[0]).toMatchObject({
      where: { id: "message-atomic", message: { equals: original } },
      data: { message: expect.objectContaining({ role: "user" }) },
    });
    expect(client.messageUpdates).toEqual([]);
  });

  it("treats reordered JSON object keys as the same persisted row", async () => {
    const input: {
      messages: Array<{ id: string; memorySessionId: string; position: number; message: unknown }>;
      errors: Array<{ id: string; memorySessionId: string; messages: unknown }>;
      onMessageFindMany: (args: unknown, call: number) => void;
    } = {
      messages: [
        {
          id: "message-reordered",
          memorySessionId: "memory-reordered",
          position: 1,
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://cdn.example/image.png" },
              },
            ],
            metadata: { first: 1, second: 2 },
          },
        },
      ],
      errors: [],
      onMessageFindMany: (args, _call) => {
        // The write pass reads the current row again. Simulate PostgreSQL
        // returning the same jsonb object with a different object-key order.
        if ((args as { where?: { memorySessionId?: string } }).where?.memorySessionId) {
          input.messages[0]!.message = {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://cdn.example/image.png" },
              },
            ],
            metadata: { second: 2, first: 1 },
          };
        }
      },
    };
    const client = fakeMigrationClient(input);

    await expect(migrateMemoryStore(client, { write: true })).resolves.toMatchObject({
      blocked: false,
    });
    expect(client.messageUpdateMany).toHaveLength(1);
  });

  it("rolls back message and failed-run updates together for one session", async () => {
    const input = {
      messages: [
        {
          id: "message-rollback",
          memorySessionId: "memory-rollback",
          position: 1,
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://cdn.example/image.png" },
              },
            ],
          },
        },
      ],
      errors: [
        {
          id: "error-rollback",
          memorySessionId: "memory-rollback",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "url", url: "https://cdn.example/failed.png" },
                },
              ],
            },
          ],
        },
      ],
      beforeErrorUpdateMany: () => {
        input.errors[0]!.messages = [
          { role: "user", content: "concurrent" },
        ] as unknown as typeof input.errors[0]["messages"];
      },
    };
    const client = fakeMigrationClient(input);

    await expect(migrateMemoryStore(client, { write: true })).rejects.toMatchObject({
      name: "MemoryMigrationDriftError",
      table: "error",
      rowId: "error-rollback",
    });
    expect(input.messages[0]!.message).toMatchObject({
      content: [{ type: "image", source: { type: "url" } }],
    });
    expect(client.transactionCount).toBe(1);
  });

  it("caps retained issue samples while counting every rejection", async () => {
    const client = fakeMigrationClient({
      messages: Array.from({ length: 101 }, (_, index) => ({
        id: `message-rejected-${index}`,
        memorySessionId: `memory-rejected-${index}`,
        position: 1,
        message: {
          role: "tool",
          content: [
            {
              type: "tool_result",
              id: `orphan-${index}`,
              content: [{ type: "text", text: "bad" }],
            },
          ],
        },
      })),
      errors: [],
    });

    const report = await auditMemoryStore(client);

    expect(report.blocked).toBe(true);
    expect(report.messages.rejected).toBe(101);
    expect(report.issues).toHaveLength(100);
  });

  it("keeps migration exception messages free of row identifiers", () => {
    const error = new MemoryMigrationDriftError("message", "secret-row-id");
    expect(error.message).not.toContain("secret-row-id");
    expect(error.rowId).toBe("secret-row-id");
  });

  it("writes changed rows in per-session transactions and is idempotent on rerun", async () => {
    const client = fakeMigrationClient({
      messages: [
        {
          id: "message-1",
          memorySessionId: "memory-1",
          position: 1,
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://cdn.example/image.png" },
              },
            ],
          },
        },
      ],
      errors: [
        {
          id: "error-1",
          memorySessionId: "memory-1",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "url", url: "https://cdn.example/failed.png" },
                },
              ],
            },
          ],
        },
      ],
    });

    const first = await migrateMemoryStore(client, { write: true });

    expect(first.blocked).toBe(false);
    expect(client.messageUpdateMany).toEqual([
      {
        where: {
          id: "message-1",
          message: {
            equals: {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "url", url: "https://cdn.example/image.png" },
                },
              ],
            },
          },
        },
        data: {
          message: {
            role: "user",
            content: [
              {
                type: "image",
                image: { type: "url", url: "https://cdn.example/image.png" },
              },
            ],
          },
        },
      },
    ]);
    expect(client.errorUpdateMany).toEqual([
      {
        where: {
          id: "error-1",
          messages: {
            equals: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "url", url: "https://cdn.example/failed.png" },
                  },
                ],
              },
            ],
          },
        },
        data: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  image: { type: "url", url: "https://cdn.example/failed.png" },
                },
              ],
            },
          ],
        },
      },
    ]);

    await migrateMemoryStore(client, { write: true });
    expect(client.messageUpdateMany).toHaveLength(1);
    expect(client.errorUpdateMany).toHaveLength(1);
  });
});

describe("formatMigrationSummary", () => {
  it("prints anonymized counts only", async () => {
    const client = fakeMigrationClient({
      messages: [
        {
          id: "sensitive-session-id",
          memorySessionId: "sensitive-memory-id",
          position: 1,
          message: {
            role: "tool",
            content: [
              {
                type: "tool_result",
                id: "sensitive-call-id",
                content: [{ type: "text", text: "secret result" }],
              },
            ],
          },
        },
      ],
      errors: [],
    });
    const report = await auditMemoryStore(client);

    const summary = formatMigrationSummary(report, { write: false });

    expect(summary).toContain("dry-run");
    expect(summary).toContain("rejected=1");
    expect(summary).not.toContain("sensitive");
    expect(summary).not.toContain("secret result");
  });
});
