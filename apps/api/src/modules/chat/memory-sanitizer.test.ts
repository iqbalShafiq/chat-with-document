import { describe, expect, it, vi } from "vitest";
import {
  createMemoryValidationGate,
  createNonVisionMemoryProxy,
  createSanitizedMemoryStore,
} from "./memory-sanitizer.js";
import { parseMessage, type MemoryStore, type Message } from "@anvia/core";

const prismaMemoryStore = vi.hoisted(() => ({
  options: undefined as unknown,
  instance: undefined as {
    append: ReturnType<typeof vi.fn>;
    validate: ReturnType<typeof vi.fn>;
    recordError: ReturnType<typeof vi.fn>;
  } | undefined,
}));

vi.mock("../../utils/prisma.js", () => ({
  prisma: {
    agentMemorySession: {
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock("@anvia/memory-prisma", () => ({
  PrismaMemoryStore: class {
    readonly kind = "prisma";
    readonly inspector = {};
    readonly compaction = {
      snapshot: vi.fn(async () => ({ revision: "r1", messages: [] as Message[] })),
      replacePrefix: vi.fn(async () => ({ status: "committed" as const })),
    };
    readonly append = vi.fn(async () => undefined);
    readonly validate = vi.fn(async () => undefined);
    readonly load = vi.fn(async () => [] as Message[]);
    readonly clear = vi.fn(async () => undefined);
    readonly recordError = vi.fn(async () => undefined);

    constructor(options: unknown) {
      prismaMemoryStore.options = options;
      prismaMemoryStore.instance = this;
    }
  },
}));

function userWithImage(imageCount: number, text = "hello"): Message {
  const parts: Array<
    | {
        type: "image";
        image: { type: "data"; data: string };
      }
    | { type: "text"; text: string }
  > = [];
  for (let index = 0; index < imageCount; index += 1) {
    parts.push({
      type: "image",
      image: { type: "data", data: `embedded-${index}` },
    });
  }
  if (text) parts.push({ type: "text", text });
  return { role: "user", content: parts } as Message;
}

function fakeInner(messages: Message[]) {
  let stored = messages;
  return {
    kind: "memory-prisma" as const,
    inspector: {},
    load: async () => stored,
    append: async (input: { messages: Message[] }) => {
      stored = [...stored, ...input.messages];
    },
    clear: async () => {
      stored = [];
    },
  };
}

describe("createNonVisionMemoryProxy", () => {
  it("strips image parts from loaded user messages, keeping text", async () => {
    const inner = fakeInner([userWithImage(2, "lihat ini")]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    const loaded = await proxy.load({} as never);
    expect(loaded).toHaveLength(1);
    const content = loaded[0]!.content as unknown as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "lihat ini" });
  });

  it("produces an empty text part for an image-only message", async () => {
    const inner = fakeInner([userWithImage(1, "")]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    const loaded = await proxy.load({} as never);
    const content = loaded[0]!.content as unknown as Array<{
      type: string;
      text: string;
    }>;
    expect(content).toEqual([{ type: "text", text: "" }]);
  });

  it("leaves text-only messages untouched", async () => {
    const inner = fakeInner([{ role: "user", content: "plain text" } as unknown as Message]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    const loaded = await proxy.load({} as never);
    expect(loaded[0]).toEqual({ role: "user", content: "plain text" });
  });

  it("does not mutate the underlying store (non-destructive)", async () => {
    const inner = fakeInner([userWithImage(1, "keep")]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    await proxy.load({} as never);
    const stored = await inner.load();
    expect(stored[0]!.content).toHaveLength(2); // image + text still there
  });

  it("strips nested v1 tool-result files from a non-vision load", async () => {
    const inner = fakeInner([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "view_image",
            output: {
              type: "content",
              value: [
                { type: "text", text: "red panda" },
                {
                  type: "file",
                  data: { type: "data", data: "aGVsbG8=" },
                  mediaType: "image/png",
                },
              ],
            },
          },
        ],
      } as Message,
    ]);
    const proxy = createNonVisionMemoryProxy(
      inner as unknown as ReturnType<typeof createSanitizedMemoryStore>,
    );

    const loaded = await proxy.load({
      scope: { sessionId: "session-1", userId: "user-1" },
    });

    expect(loaded).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "view_image",
            output: {
              type: "content",
              value: [{ type: "text", text: "red panda" }],
            },
          },
        ],
      },
    ]);
  });

  it("preserves URL-backed and textual tool-result files while stripping embedded data", async () => {
    const inner = fakeInner([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "inspect_file",
            output: {
              type: "content",
              value: [
                {
                  type: "file",
                  data: { type: "url", url: "https://cdn.example/result.pdf" },
                  mediaType: "application/pdf",
                  filename: "result.pdf",
                },
                {
                  type: "file",
                  data: { type: "url", url: "https://cdn.example/result.png" },
                  mediaType: "image/png",
                  filename: "result.png",
                },
                {
                  type: "file",
                  data: { type: "text", text: "safe extracted text" },
                  mediaType: "text/plain",
                  filename: "result.txt",
                },
                {
                  type: "file",
                  data: { type: "data", data: "aGVsbG8=" },
                  mediaType: "image/png",
                  filename: "embedded.png",
                },
              ],
            },
          },
        ],
      } as Message,
    ]);
    const proxy = createNonVisionMemoryProxy(
      inner as unknown as ReturnType<typeof createSanitizedMemoryStore>,
    );

    const loaded = await proxy.load({
      scope: { sessionId: "session-1", userId: "user-1" },
    });

    expect(loaded[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "inspect_file",
          output: {
            type: "content",
            value: [
              {
                type: "file",
                data: { type: "url", url: "https://cdn.example/result.pdf" },
                mediaType: "application/pdf",
                filename: "result.pdf",
              },
              {
                type: "file",
                data: { type: "text", text: "safe extracted text" },
                mediaType: "text/plain",
                filename: "result.txt",
              },
            ],
          },
        },
      ],
    });
  });

  it("strips URL-backed images but preserves safe URL-backed files", async () => {
    const inner = fakeInner([
      {
        role: "user",
        content: [
          {
            type: "image",
            image: { type: "url", url: "https://cdn.example/photo.png" },
            mediaType: "image/png",
          },
          {
            type: "file",
            data: { type: "url", url: "https://cdn.example/brief.pdf" },
            mediaType: "application/pdf",
            filename: "brief.pdf",
          },
        ],
      } as Message,
    ]);
    const proxy = createNonVisionMemoryProxy(
      inner as unknown as ReturnType<typeof createSanitizedMemoryStore>,
    );

    await expect(
      proxy.load({ scope: { sessionId: "session-1", userId: "user-1" } }),
    ).resolves.toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: { type: "url", url: "https://cdn.example/brief.pdf" },
            mediaType: "application/pdf",
            filename: "brief.pdf",
          },
        ],
      },
    ]);
  });

  it("does not expose official prisma compaction on a store without it", () => {
    const inner = fakeInner([]);
    const proxy = createNonVisionMemoryProxy(
      inner as unknown as ReturnType<typeof createSanitizedMemoryStore>,
    );
    expect("compaction" in proxy ? proxy.compaction : undefined).toBeUndefined();
  });

  it("preserves prototype-backed v1 append, clear, and error methods", async () => {
    class PrototypeStore implements MemoryStore {
      async load(): Promise<Message[]> {
        return [];
      }

      async append(): Promise<void> {
        return undefined;
      }

      async clear(): Promise<void> {
        return undefined;
      }

      async recordError(): Promise<void> {
        return undefined;
      }
    }

    const proxy = createNonVisionMemoryProxy(new PrototypeStore());

    expect(proxy.append).toBeTypeOf("function");
    expect(proxy.clear).toBeTypeOf("function");
    expect(proxy.recordError).toBeTypeOf("function");
  });
});

describe("createSanitizedMemoryStore", () => {
  it("constructs the v1 PrismaMemoryStore with the existing user-scoped key", async () => {
    const { createSanitizedMemoryStore } = await import("./memory-sanitizer.js");
    const prisma = {} as never;

    const store = createSanitizedMemoryStore(prisma);
    const options = prismaMemoryStore.options as {
      client: unknown;
      errorPolicy: string;
      validateMessages: boolean;
      scopeKey: (input: { scope: { sessionId: string; userId?: string } }) => string;
    };

    expect((store as typeof store & { kind: string }).kind).toBe("prisma");
    expect(options.client).toBe(prisma);
    expect(options.errorPolicy).toBe("store");
    expect(options.validateMessages).toBe(true);
    expect(
      options.scopeKey({ scope: { sessionId: "session-1", userId: "user-1" } }),
    ).toBe(JSON.stringify(["session-1", "user-1"]));
    expect(store.compaction).toEqual(
      expect.objectContaining({
        snapshot: expect.any(Function),
        replacePrefix: expect.any(Function),
      }),
    );
  });

  it("exposes strict PrismaMemoryStore validation", async () => {
    const store = createSanitizedMemoryStore({} as never);

    await store.validate();

    expect(prismaMemoryStore.instance?.validate).toHaveBeenCalledOnce();
  });

  it("sanitizes v1 tool-result file content before append while preserving text and pairing", async () => {
    const { createSanitizedMemoryStore } = await import("./memory-sanitizer.js");
    const prisma = {
      agentMemorySession: {
        findUnique: vi.fn(async () => ({ metadata: { compaction: [] } })),
      },
    } as never;
    const store = createSanitizedMemoryStore(prisma);

    const message = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          callId: "run-call-1",
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "image description" },
              {
                type: "file",
                data: { type: "data", data: "aGVsbG8=" },
                mediaType: "image/png",
              },
            ],
          },
        },
      ],
    } as Message;

    await store.append({
      scope: { sessionId: "session-1", userId: "user-1" },
      runId: "run-1",
      turn: 1,
      messages: [message],
    });

    expect(prismaMemoryStore.instance?.append).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          sessionId: "session-1",
          userId: "user-1",
        }),
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                callId: "run-call-1",
                toolName: "view_image",
                output: {
                  type: "content",
                  value: [{ type: "text", text: "image description" }],
                },
              },
            ],
          },
        ],
      }),
    );
  });

  it("preserves URL-backed and textual files when sanitizing append payloads", async () => {
    const prisma = {
      agentMemorySession: {
        findUnique: vi.fn(async () => ({ metadata: {} })),
      },
    } as never;
    const store = createSanitizedMemoryStore(prisma);

    await store.append({
      scope: { sessionId: "session-1", userId: "user-1" },
      runId: "run-1",
      turn: 1,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "inspect_file",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    data: { type: "url", url: "https://cdn.example/result.pdf" },
                    mediaType: "application/pdf",
                    filename: "result.pdf",
                  },
                  {
                    type: "file",
                    data: { type: "text", text: "safe extracted text" },
                    mediaType: "text/plain",
                    filename: "result.txt",
                  },
                  {
                    type: "file",
                    data: { type: "data", data: "aGVsbG8=" },
                    mediaType: "image/png",
                    filename: "embedded.png",
                  },
                ],
              },
            },
          ],
        } as Message,
      ],
    });

    expect(prismaMemoryStore.instance?.append).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "inspect_file",
                output: {
                  type: "content",
                  value: [
                    {
                      type: "file",
                      data: { type: "url", url: "https://cdn.example/result.pdf" },
                      mediaType: "application/pdf",
                      filename: "result.pdf",
                    },
                    {
                      type: "file",
                      data: { type: "text", text: "safe extracted text" },
                      mediaType: "text/plain",
                      filename: "result.txt",
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
  });

  it("removes embedded message rich parts but preserves URL/text file UX", async () => {
    const prisma = {
      agentMemorySession: {
        findUnique: vi.fn(async () => ({ metadata: {} })),
      },
    } as never;
    const store = createSanitizedMemoryStore(prisma);

    await store.append({
      scope: { sessionId: "session-1", userId: "user-1" },
      runId: "run-1",
      turn: 1,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image",
              image: { type: "data", data: "embedded-image" },
              mediaType: "image/png",
            },
            {
              type: "image",
              image: { type: "url", url: "https://cdn.example/photo.png" },
              mediaType: "image/png",
            },
            {
              type: "file",
              data: { type: "data", data: "embedded-file" },
              mediaType: "application/pdf",
              filename: "embedded.pdf",
            },
            {
              type: "file",
              data: { type: "url", url: "https://cdn.example/brief.pdf" },
              mediaType: "application/pdf",
              filename: "brief.pdf",
            },
            {
              type: "file",
              data: { type: "text", text: "safe extracted text" },
              mediaType: "text/plain",
              filename: "brief.txt",
            },
          ],
        } as Message,
      ],
    });

    expect(prismaMemoryStore.instance?.append).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              {
                type: "image",
                image: { type: "url", url: "https://cdn.example/photo.png" },
                mediaType: "image/png",
              },
              {
                type: "file",
                data: { type: "url", url: "https://cdn.example/brief.pdf" },
                mediaType: "application/pdf",
                filename: "brief.pdf",
              },
              {
                type: "file",
                data: { type: "text", text: "safe extracted text" },
                mediaType: "text/plain",
                filename: "brief.txt",
              },
            ],
          },
        ],
      }),
    );
  });

  it("sanitizes data-backed rich content in recordError payloads too", async () => {
    const prisma = {
      agentMemorySession: {
        findUnique: vi.fn(async () => ({ metadata: {} })),
      },
    } as never;
    const store = createSanitizedMemoryStore(prisma);

    await store.recordError?.({
      scope: { sessionId: "session-1", userId: "user-1" },
      runId: "run-1",
      error: new Error("failed"),
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "view_image",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "description" },
                  {
                    type: "file",
                    data: { type: "data", data: "aGVsbG8=" },
                    mediaType: "image/png",
                  },
                ],
              },
            },
          ],
        } as Message,
      ],
    });

    expect(prismaMemoryStore.instance?.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "view_image",
                output: {
                  type: "content",
                  value: [{ type: "text", text: "description" }],
                },
              },
            ],
          },
        ],
      }),
    );
  });
});

describe("createMemoryValidationGate", () => {
  it("runs startup validation once even when called by multiple job paths", async () => {
    const validate = vi.fn(async () => undefined);
    const ensureReady = createMemoryValidationGate(validate);

    await Promise.all([ensureReady(), ensureReady(), ensureReady()]);

    expect(validate).toHaveBeenCalledOnce();
  });
});

describe("persisted message compatibility", () => {
  it("proves representative v0 tool rows require one-time normalization before v1 validation", () => {
    const legacyAssistant = {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "call-1",
          function: { name: "search_docs", arguments: "{}" },
        },
      ],
    };
    const legacyTool = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          id: "call-1",
          content: [{ type: "text", text: "result" }],
        },
      ],
    };

    expect(() => parseMessage(legacyAssistant)).toThrow();
    expect(() => parseMessage(legacyTool)).toThrow();
  });

  it("proves PrismaMemoryStore.load rejects representative persisted v0 rows", async () => {
    const { PrismaMemoryStore: ActualPrismaMemoryStore } =
      await vi.importActual<typeof import("@anvia/memory-prisma")>(
        "@anvia/memory-prisma",
      );
    const legacyRows = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            function: { name: "search_docs", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            id: "call-1",
            content: [{ type: "text", text: "result" }],
          },
        ],
      },
    ];

    for (const message of legacyRows) {
      const delegates = {
        sessions: {
          upsert: vi.fn(),
          deleteMany: vi.fn(),
        },
        messages: {
          findMany: vi.fn(async () => [{ message }]),
          findFirst: vi.fn(),
          createMany: vi.fn(),
        },
        transaction: vi.fn(),
      };
      const store = new ActualPrismaMemoryStore({
        delegates,
        validateMessages: true,
        errorPolicy: "ignore",
      });

      await expect(
        store.load({ scope: { sessionId: "session-1", userId: "user-1" } }),
      ).rejects.toThrow(
        "Stored Prisma memory row does not contain a valid Anvia Message",
      );
    }
  });

});
