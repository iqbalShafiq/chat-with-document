import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { ToolApprovalRequest } from "@anvia/core";
import type { ImageGenerationModel } from "@anvia/core/image-generation";
import type { GeneratedImageRecord } from "@assingment/agent";
import {
  createApprovalRegistry,
  type ApprovalRedis,
} from "./approval-registry.js";
// The shared helper lives in packages/agent. Its VALUES cannot be statically
// imported here: that would pull the file (and its providers/ imports) into
// the api program, tripping rootDir on `tsc` emit. The helper module has no
// credential-throwing side effects, so loading it via vi.importActual is safe.
// The mirror types below are the compile-time view (keep in sync with
// packages/agent/src/e2e/image-e2e-helpers.ts); everything else is typed from
// @anvia/core and @assingment/agent package types.
const helpers = (await vi.importActual(
  "../../../../../packages/agent/src/e2e/image-e2e-helpers.js",
)) as ImageE2EHelpers;

type ImageE2EHelpers = {
  startStubServer(): Promise<{
    server: Server;
    port: number;
    requests: StubImageRequest[];
  }>;
  createStubOpenRouterModel(port: number): ImageGenerationModel<unknown, string>;
  approvalContext(args: Record<string, unknown>): ApprovalContext;
  approvalRequest(overrides?: Partial<ToolApprovalRequest>): ToolApprovalRequest;
  createSaveGeneratedImageMock(): SaveGeneratedImage;
};

type ApprovalContext = {
  toolName: string;
  args: Record<string, unknown>;
  rawArgs: string;
  internalCallId: string;
  run: { runId: string; agentId: string; sessionId: string };
};

type ApprovalPolicy = {
  when(context: unknown): boolean | Promise<boolean>;
  reason(context: { args: { prompt: string } }): string;
  rejectMessage?: string;
};

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

type SaveGeneratedImage = (input: {
  userId: string;
  sessionId: string;
  projectId: string | null;
  buffer: Uint8Array;
  mediaType: string | undefined;
  modelId: string;
  prompt: string;
  width: number;
  height: number;
  nOfTotal?: string;
}) => Promise<GeneratedImageRecord>;

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const STREAM_ID = "stream-1";

const REJECT_MESSAGE = "Image generation was declined by the user.";

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

let agentModule: typeof import("@assingment/agent");
let server: Server;
let stubRequests: StubImageRequest[];
let port: number;

beforeAll(async () => {
  // @assingment/agent evaluates OpenAIClient/MistralClient construction at
  // module load (see compaction.ts), so fake credentials are stubbed first.
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("MISTRAL_API_KEY", "test-key");
  agentModule = await import("@assingment/agent");

  const stub = await helpers.startStubServer();
  server = stub.server;
  stubRequests = stub.requests;
  port = stub.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  vi.unstubAllEnvs();
});

beforeEach(() => {
  stubRequests.length = 0;
});

/**
 * Real image tools wired to the real registry the same way the worker wires
 * them (build-run-input.ts): grants/overrides are live per-call reads.
 */
function buildImageTools(
  registry: ReturnType<typeof createApprovalRegistry>,
) {
  const saveGeneratedImage = helpers.createSaveGeneratedImageMock();
  const tools = agentModule.createImageGenerationTools({
    model: helpers.createStubOpenRouterModel(port),
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
    const context = helpers.approvalContext({ prompt: "a red panda" });

    expect(await approval.when(context)).toBe(true);

    const handler = createHandler(registry, recorder);
    const pending = handler({
      ...helpers.approvalRequest(),
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
    const context = helpers.approvalContext({ prompt: "a red panda" });

    const handler = createHandler(registry, recorder);
    const pending = handler({
      ...helpers.approvalRequest(),
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
  it("returns a rejection decision and surfaces a rejected result event", async () => {
    const { recorder, registry } = setup();
    const { tools } = buildImageTools(registry);
    const approval = tools[0]!.approval as ApprovalPolicy;

    const handler = createHandler(registry, recorder);
    const pending = handler({
      ...helpers.approvalRequest(),
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

    // append pushes events in order (request first, then result) and resolves
    // the request-event promise synchronously, so by the time the handler's
    // polling has resolved, events[1] is this approval's result event.
    const resultEvent = recorder.events[1] as ToolApprovalResultEvent;
    expect(resultEvent.type).toBe("tool_approval_result");
    expect(resultEvent.approval).toMatchObject({
      id: requestEvent.approval.id,
      toolName: "generate_image",
      status: "rejected",
      reason: "no",
    });

    // Whether the tool actually executes after a rejection is decided by
    // @anvia/core's agent loop (it never runs an unapproved tool call), which
    // is not exercised at this component level — the contract asserted here is
    // the handler's rejected decision plus the surfaced result event.
  });
});
