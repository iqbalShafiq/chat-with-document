import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolApprovalRequest } from "@anvia/core";
import {
  createApprovalRegistry,
  type ApprovalRedis,
} from "./approval-registry.js";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const STREAM_ID = "stream-1";

/** 1x1 transparent PNG — decodes cleanly through the model's base64 path. */
const TRANSPARENT_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const REJECT_MESSAGE = "Image generation was declined by the user.";

type StubImageRequest = {
  model: string;
  prompt: string;
  size: string;
  n?: number;
  background?: string;
  output_format?: string;
  quality?: string;
  input_references?: Array<{
    type: "image_url";
    image_url: { url: string };
  }>;
};

/**
 * Stub OpenRouter images endpoint: records every request body and answers
 * with `n` (default 1) copies of a 1x1 transparent PNG, mirroring the
 * `{ data: [{ b64_json, media_type }] }` contract the real API returns.
 */
function startStubServer(): Promise<{
  server: Server;
  port: number;
  requests: StubImageRequest[];
}> {
  const requests: StubImageRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/v1/images") {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body as unknown as StubImageRequest);
      const count = typeof body.n === "number" ? body.n : 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: Array.from({ length: count }, () => ({
            b64_json: TRANSPARENT_1X1_PNG_BASE64,
            media_type: "image/png",
          })),
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port, requests });
    });
  });
}

type ToolApprovalRequestEvent = {
  type: "tool_approval_request";
  approval: {
    id: string;
    runId: string;
    agentId: string;
    sessionId: string;
    toolName: string;
    callId?: string;
    internalCallId: string;
    args: string;
    status: string;
    requestedAt: string;
    reason?: string;
  };
};

type ToolApprovalResultEvent = {
  type: "tool_approval_result";
  approval: {
    id: string;
    toolName: string;
    status: string;
    resolvedAt: string;
    reason?: string;
  };
};

type ClarificationRequestEvent = {
  type: "clarification_request";
  clarification: {
    id: string;
    sessionId: string;
    title?: string;
    questions: Array<{
      id: string;
      question: string;
      type: string;
      options?: Array<{ id: string; label: string; recommended?: boolean }>;
    }>;
    status: string;
    requestedAt: string;
  };
};

type ApprovalPolicy = {
  when(context: unknown): boolean | Promise<boolean>;
  reason(context: { args: { prompt: string } }): string;
  rejectMessage?: string;
};

/** Map-backed fake for the narrow ApprovalRedis surface (mirrors approval-registry.test.ts). */
function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    hset: vi.fn(async (key: string, fields: Record<string, unknown>) => {
      const merged = { ...JSON.parse(store.get(key) ?? "{}"), ...fields };
      store.set(key, JSON.stringify(merged));
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => {
      const raw = store.get(key);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    }),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK" as const;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
      }
      return removed;
    }),
  };
}

/**
 * Captures appended events. The request-event promise resolves synchronously
 * while `append` runs, so a test can publish the decision before the handler's
 * first poll reads the decision key (tests stay ~0ms instead of one 500ms poll).
 */
function createAppendRecorder() {
  const events: unknown[] = [];
  let resolveRequest!: (event: unknown) => void;
  let requestSettled = false;
  const requestEvent = new Promise<unknown>((resolve) => {
    resolveRequest = resolve;
  });
  const append = async (event: unknown) => {
    events.push(event);
    if (
      !requestSettled &&
      (event as { type?: string }).type === "tool_approval_request"
    ) {
      requestSettled = true;
      resolveRequest(event);
    }
  };
  return { events, requestEvent, append };
}

/** Same recorder, resolving on `clarification_request` events. */
function createClarificationRecorder() {
  const events: unknown[] = [];
  let resolveRequest!: (event: unknown) => void;
  let requestSettled = false;
  const requestEvent = new Promise<unknown>((resolve) => {
    resolveRequest = resolve;
  });
  const append = async (event: unknown) => {
    events.push(event);
    if (
      !requestSettled &&
      (event as { type?: string }).type === "clarification_request"
    ) {
      requestSettled = true;
      resolveRequest(event);
    }
  };
  return { events, requestEvent, append };
}

function setup() {
  const fake = createFakeRedis();
  const recorder = createAppendRecorder();
  const registry = createApprovalRegistry(fake as unknown as ApprovalRedis);
  return { fake, recorder, registry };
}

function createHandler(
  registry: ReturnType<typeof createApprovalRegistry>,
  recorder: ReturnType<typeof createAppendRecorder>,
) {
  return registry.createHandler({
    userId: USER_ID,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    append: recorder.append,
  });
}

function approvalContext(args: Record<string, unknown>) {
  return {
    toolName: "generate_image",
    args,
    rawArgs: JSON.stringify(args),
    internalCallId: "internal-call-1",
    run: { runId: "run-1", agentId: "agent-1", sessionId: SESSION_ID },
  };
}

function approvalRequest(
  overrides: Partial<ToolApprovalRequest> = {},
): ToolApprovalRequest {
  return {
    toolName: "generate_image",
    args: { prompt: "a red panda" },
    rawArgs: JSON.stringify({ prompt: "a red panda" }),
    internalCallId: "internal-call-1",
    run: { runId: "run-1", agentId: "agent-1", sessionId: SESSION_ID },
    ...overrides,
  };
}

let agentModule: typeof import("@assingment/agent");
let server: Server;
let stubRequests: StubImageRequest[];
let port: number;

beforeAll(async () => {
  // @assingment/agent evaluates OpenAIClient/MistralClient construction at
  // module load (see compaction.ts), so fake credentials are set first.
  process.env.OPENAI_API_KEY = "test-key";
  process.env.MISTRAL_API_KEY = "test-key";
  agentModule = await import("@assingment/agent");

  const stub = await startStubServer();
  server = stub.server;
  stubRequests = stub.requests;
  port = stub.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  stubRequests.length = 0;
});

function createModel(): InstanceType<
  typeof agentModule.OpenRouterImageGenerationModel
> {
  return new agentModule.OpenRouterImageGenerationModel({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    fetchFn: fetch,
  });
}

/**
 * Real image tools wired to the real registry the same way the worker wires
 * them (build-run-input.ts): grants/overrides are live per-call reads.
 */
function buildImageTools(
  registry: ReturnType<typeof createApprovalRegistry>,
) {
  const saveGeneratedImage = vi.fn();
  let recordCount = 0;
  saveGeneratedImage.mockImplementation(
    async (input: {
      mediaType: string | undefined;
      width: number;
      height: number;
      modelId: string;
      prompt: string;
    }) => ({
      id: `rec-${++recordCount}`,
      mediaType: input.mediaType ?? "image/png",
      width: input.width,
      height: input.height,
      modelId: input.modelId,
      prompt: input.prompt,
    }),
  );
  const tools = agentModule.createImageGenerationTools({
    model: createModel(),
    store: { saveGeneratedImage },
    enabled: false,
    hasGrant: (toolName: string) =>
      registry.hasToolGrant(SESSION_ID, toolName),
    takeToolOverride: (toolName: string) =>
      registry.takeToolOverride(SESSION_ID, toolName),
    userId: USER_ID,
    sessionId: SESSION_ID,
    projectId: null,
    resolveReference: async () => null,
    capabilities: () => null,
  });
  return { tools, saveGeneratedImage };
}

describe("consent gate flow (Allow once)", () => {
  it("suspends the run for approval, resumes after an allow-once decision, and never persists a grant", async () => {
    const { recorder, registry } = setup();
    const { tools, saveGeneratedImage } = buildImageTools(registry);
    const approval = tools[0]!.approval as ApprovalPolicy;
    const context = approvalContext({ prompt: "a red panda" });

    expect(await approval.when(context)).toBe(true);

    const handler = createHandler(registry, recorder);
    const pending = handler({
      ...approvalRequest(),
      reason: approval.reason({ args: { prompt: "a red panda" } }),
      rejectMessage: REJECT_MESSAGE,
    });

    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    expect(requestEvent.approval).toMatchObject({
      toolName: "generate_image",
      sessionId: SESSION_ID,
      status: "pending",
    });
    expect(requestEvent.approval.args).toContain("a red panda");

    await registry.publishDecision(requestEvent.approval.id, {
      approved: true,
    });
    await expect(pending).resolves.toEqual({ approved: true });

    const output = (await tools[0]!.call({
      prompt: "a red panda",
    })) as { images: unknown[] };
    expect(output.images).toHaveLength(1);
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]!.prompt).toBe("a red panda");

    await expect(
      registry.hasToolGrant(SESSION_ID, "generate_image"),
    ).resolves.toBe(false);
    expect(await approval.when(context)).toBe(true);
  });
});

describe("allow for session persists", () => {
  it("keeps the grant after an approved run so later calls skip the gate", async () => {
    const { recorder, registry } = setup();
    const { tools, saveGeneratedImage } = buildImageTools(registry);
    const approval = tools[0]!.approval as ApprovalPolicy;
    const context = approvalContext({ prompt: "a red panda" });

    const handler = createHandler(registry, recorder);
    const pending = handler({
      ...approvalRequest(),
      reason: approval.reason({ args: { prompt: "a red panda" } }),
      rejectMessage: REJECT_MESSAGE,
    });
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;

    await registry.publishDecision(requestEvent.approval.id, {
      approved: true,
    });
    await expect(pending).resolves.toEqual({ approved: true });

    await registry.grantTool({
      sessionId: SESSION_ID,
      toolName: "generate_image",
    });

    await expect(
      registry.hasToolGrant(SESSION_ID, "generate_image"),
    ).resolves.toBe(true);
    expect(await approval.when(context)).toBe(false);

    await tools[0]!.call({ prompt: "a red panda" });
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]!.prompt).toBe("a red panda");
  });
});

describe("clarification flow", () => {
  it("asks the user questions, resolves the answers, and feeds them into generation", async () => {
    const { registry } = setup();
    const recorder = createClarificationRecorder();
    const requester = registry.createClarificationRequester({
      userId: USER_ID,
      sessionId: SESSION_ID,
      streamId: STREAM_ID,
      append: recorder.append,
    });
    const clarificationTool = agentModule.createClarificationTool({ requester });

    const questions = [
      {
        id: "aspect_ratio",
        question: "Which aspect ratio should the image use?",
        type: "single_choice" as const,
        options: [
          { id: "1:1", label: "Square (1:1)" },
          { id: "16:9", label: "Wide (16:9)", recommended: true },
        ],
      },
      {
        id: "style_notes",
        question: "Any style notes?",
        type: "free_text" as const,
        optional: true,
      },
    ];

    const pending = clarificationTool.call({ questions });
    const requestEvent =
      (await recorder.requestEvent) as ClarificationRequestEvent;

    expect(requestEvent.type).toBe("clarification_request");
    expect(requestEvent.clarification.questions).toHaveLength(2);
    expect(requestEvent.clarification.questions[0]?.id).toBe("aspect_ratio");
    expect(requestEvent.clarification.questions[1]?.id).toBe("style_notes");

    await registry.publishClarificationResponse(requestEvent.clarification.id, {
      answers: { aspect_ratio: "16:9", style_notes: "watercolor" },
      skipped: [],
    });
    const result = (await pending) as {
      status: string;
      answers: Record<string, string>;
      skipped: string[];
    };
    expect(result).toMatchObject({
      status: "answered",
      answers: { aspect_ratio: "16:9", style_notes: "watercolor" },
      skipped: [],
    });

    const { tools, saveGeneratedImage } = buildImageTools(registry);
    await tools[0]!.call({
      prompt: "a red panda",
      aspectRatio: result.answers.aspect_ratio,
    });

    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]!.prompt).toBe("a red panda");
    expect(stubRequests[0]!.size).toBe("1344x768");
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
  });
});

describe("override flow", () => {
  it("applies a staged UI override over the model's prompt and consumes it atomically", async () => {
    const { registry } = setup();
    const { tools, saveGeneratedImage } = buildImageTools(registry);

    await registry.setToolOverride({
      sessionId: SESSION_ID,
      toolName: "generate_image",
      args: { prompt: "override prompt" },
    });

    await tools[0]!.call({ prompt: "original prompt" });

    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]!.prompt).toBe("override prompt");
    expect(saveGeneratedImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "override prompt" }),
    );
    await expect(
      registry.takeToolOverride(SESSION_ID, "generate_image"),
    ).resolves.toBeNull();
  });
});

describe("reject flow", () => {
  it("returns a rejection decision and never calls the model or the store", async () => {
    const { recorder, registry } = setup();
    const { tools, saveGeneratedImage } = buildImageTools(registry);
    const approval = tools[0]!.approval as ApprovalPolicy;

    const handler = createHandler(registry, recorder);
    const pending = handler({
      ...approvalRequest(),
      reason: approval.reason({ args: { prompt: "a red panda" } }),
      rejectMessage: REJECT_MESSAGE,
    });
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;

    await registry.publishDecision(requestEvent.approval.id, {
      approved: false,
      reason: "no",
    });
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: "no",
    });

    const resultEvent = recorder.events[1] as ToolApprovalResultEvent;
    expect(resultEvent.type).toBe("tool_approval_result");
    expect(resultEvent.approval).toMatchObject({
      id: requestEvent.approval.id,
      toolName: "generate_image",
      status: "rejected",
      reason: "no",
    });

    expect(saveGeneratedImage).not.toHaveBeenCalled();
    expect(stubRequests).toHaveLength(0);
  });
});
