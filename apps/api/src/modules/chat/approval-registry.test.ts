import { describe, expect, it, vi } from "vitest";
import type { ToolApprovalRequest } from "@anvia/core";
import {
  createApprovalRegistry,
  type ApprovalRedis,
  type ClarificationRequest,
} from "./approval-registry.js";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const STREAM_ID = "stream-1";

// Mirrors the module's internal key helpers.
const APPROVAL_KEY = (approvalId: string) => `chat-approval:${approvalId}`;
const DECISION_KEY = (approvalId: string) =>
  `chat-approval:${approvalId}:decision`;

// APPROVAL_TTL_SECONDS (15 min) and DECISION_TTL_SECONDS (5 min) in the module.
const APPROVAL_TTL_SECONDS = 15 * 60;
const DECISION_TTL_SECONDS = 5 * 60;

// Mirrors the module's grant/override/clarification key helpers.
const GRANT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const OVERRIDE_TTL_SECONDS = 5 * 60;
const CLARIFICATION_TTL_SECONDS = 15 * 60;

const GRANT_KEY = (sessionId: string, toolName: string) =>
  `chat-tool-grant:${sessionId}:${toolName}`;
const OVERRIDE_KEY = (sessionId: string, toolName: string) =>
  `chat-tool-override:${sessionId}:${toolName}`;
const CLARIFICATION_KEY = (id: string) => `chat-clarification:${id}`;
const CLARIFICATION_DECISION_KEY = (id: string) =>
  `chat-clarification:${id}:decision`;

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

type ClarificationResponseEvent = {
  type: "clarification_response";
  clarification: {
    id: string;
    status: string;
    resolvedAt: string;
  };
};

function makeRequest(
  overrides: Partial<ToolApprovalRequest> = {},
): ToolApprovalRequest {
  return {
    toolName: "web_search",
    args: { query: "anvia approval registry" },
    rawArgs: JSON.stringify({ query: "anvia approval registry" }),
    internalCallId: "internal-call-1",
    run: { runId: "run-1", agentId: "agent-1", sessionId: "session-1" },
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map-backed fake for the narrow ApprovalRedis surface. */
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
  // ioredis generates heavy overloads; the fake implements exactly the
  // methods the registry calls, cast at the injection boundary.
  const fake = createFakeRedis();
  const recorder = createAppendRecorder();
  const registry = createApprovalRegistry(
    fake as unknown as ApprovalRedis,
  );
  return { fake, recorder, registry };
}

function createHandler(
  registry: ReturnType<typeof createApprovalRegistry>,
  recorder: ReturnType<typeof createAppendRecorder>,
  timeoutMs?: number,
) {
  return registry.createHandler({
    userId: USER_ID,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    append: recorder.append,
    timeoutMs,
  });
}

describe("createApprovalRegistry", () => {
  it("stores the request in redis and appends a tool_approval_request event", async () => {
    const { fake, recorder, registry } = setup();

    const handler = createHandler(registry, recorder, 50);
    const pending = handler(
      makeRequest({ toolCallId: "tool-call-1", reason: "web toggle is off" }),
    );
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    const storedRecord = fake.hset.mock.calls[0]?.[1];
    expect(storedRecord).toMatchObject({
      approvalId,
      userId: USER_ID,
      sessionId: SESSION_ID,
      streamId: STREAM_ID,
      toolName: "web_search",
      args: JSON.stringify({ query: "anvia approval registry" }),
      reason: "web toggle is off",
      status: "pending",
      requestedAt: expect.any(String),
    });

    await registry.publishDecision(approvalId, { approved: true });
    await pending;

    expect(requestEvent.type).toBe("tool_approval_request");
    expect(requestEvent.approval).toMatchObject({
      id: expect.any(String),
      runId: "run-1",
      agentId: "agent-1",
      sessionId: SESSION_ID,
      toolName: "web_search",
      callId: "tool-call-1",
      internalCallId: "internal-call-1",
      args: JSON.stringify({ query: "anvia approval registry" }),
      status: "pending",
      reason: "web toggle is off",
    });
    expect(requestEvent.approval.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    expect(fake.hset).toHaveBeenCalledWith(
      APPROVAL_KEY(approvalId),
      expect.objectContaining({
        approvalId,
        userId: USER_ID,
        sessionId: SESSION_ID,
        streamId: STREAM_ID,
        toolName: "web_search",
        args: JSON.stringify({ query: "anvia approval registry" }),
        reason: "web toggle is off",
        status: "pending",
        requestedAt: expect.any(String),
      }),
    );
    expect(fake.expire).toHaveBeenCalledWith(
      APPROVAL_KEY(approvalId),
      APPROVAL_TTL_SECONDS,
    );
  });

  it("resolves approved when a decision is published", async () => {
    const { fake, recorder, registry } = setup();

    const pending = createHandler(registry, recorder)(makeRequest());
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    await registry.publishDecision(approvalId, { approved: true });
    await expect(pending).resolves.toEqual({ approved: true });

    expect(fake.set).toHaveBeenCalledWith(
      DECISION_KEY(approvalId),
      expect.any(String),
      "EX",
      DECISION_TTL_SECONDS,
    );
    expect(fake.hset).toHaveBeenLastCalledWith(
      APPROVAL_KEY(approvalId),
      expect.objectContaining({
        status: "approved",
        resolvedAt: expect.any(String),
      }),
    );

    const resultEvent = recorder.events[1] as ToolApprovalResultEvent;
    expect(resultEvent.type).toBe("tool_approval_result");
    expect(resultEvent.approval).toMatchObject({
      id: approvalId,
      toolName: "web_search",
      status: "approved",
      resolvedAt: expect.any(String),
    });
  });

  it("resolves rejected when a negative decision is published", async () => {
    const { fake, recorder, registry } = setup();

    const pending = createHandler(registry, recorder)(makeRequest());
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    await registry.publishDecision(approvalId, {
      approved: false,
      reason: "not needed",
    });
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: "not needed",
    });

    const resultEvent = recorder.events[1] as ToolApprovalResultEvent;
    expect(resultEvent.type).toBe("tool_approval_result");
    expect(resultEvent.approval).toMatchObject({
      id: approvalId,
      toolName: "web_search",
      status: "rejected",
      resolvedAt: expect.any(String),
      reason: "not needed",
    });

    expect(fake.hset).toHaveBeenLastCalledWith(
      APPROVAL_KEY(approvalId),
      expect.objectContaining({
        status: "rejected",
        decisionReason: "not needed",
      }),
    );
  });

  it("times out and rejects when no decision arrives", async () => {
    const { fake, recorder, registry } = setup();

    const pending = createHandler(registry, recorder, 50)(makeRequest());
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    const result = await pending;
    expect(result).toMatchObject({ approved: false });
    const reason = typeof result === "object" ? result.reason : undefined;
    expect(reason).toMatch(/timed out/i);

    const resultEvent = recorder.events[1] as ToolApprovalResultEvent;
    expect(resultEvent.type).toBe("tool_approval_result");
    expect(resultEvent.approval).toMatchObject({
      id: approvalId,
      toolName: "web_search",
      status: "timed_out",
      resolvedAt: expect.any(String),
    });

    expect(fake.get).toHaveBeenCalledWith(DECISION_KEY(approvalId));
    expect(fake.hset).toHaveBeenLastCalledWith(
      APPROVAL_KEY(approvalId),
      expect.objectContaining({
        status: "timed_out",
        resolvedAt: expect.any(String),
      }),
    );
    expect(fake.del).toHaveBeenCalledWith(
      APPROVAL_KEY(approvalId),
      DECISION_KEY(approvalId),
    );
  });

  it("deletes both keys once the decision is processed", async () => {
    const { fake, recorder, registry } = setup();

    const pending = createHandler(registry, recorder)(makeRequest());
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    await registry.publishDecision(approvalId, { approved: true });
    await pending;

    expect(fake.del).toHaveBeenCalledWith(
      APPROVAL_KEY(approvalId),
      DECISION_KEY(approvalId),
    );
    await expect(registry.getApproval(approvalId)).resolves.toBeNull();
    await expect(fake.get(DECISION_KEY(approvalId))).resolves.toBeNull();

    await registry.removeApproval(approvalId);
    expect(fake.del).toHaveBeenCalledTimes(2);
  });

  it("ignores duplicate publishes of the same decision", async () => {
    const { fake, recorder, registry } = setup();

    const pending = createHandler(registry, recorder)(makeRequest());
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    await registry.publishDecision(approvalId, { approved: true });
    await registry.publishDecision(approvalId, { approved: true });
    await expect(pending).resolves.toEqual({ approved: true });

    expect(fake.set).toHaveBeenCalledTimes(2);
    expect(fake.set.mock.calls[0]?.[0]).toBe(DECISION_KEY(approvalId));
    expect(fake.set.mock.calls[1]?.[0]).toBe(DECISION_KEY(approvalId));

    const resultEvent = recorder.events[1] as ToolApprovalResultEvent;
    expect(resultEvent.approval.status).toBe("approved");
  });

  it("resolves approved when the decision arrives after the first poll", async () => {
    const { recorder, registry } = setup();

    const pending = createHandler(registry, recorder, 2000)(makeRequest());
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    // The first poll (~0ms) has missed by now; the second poll (~500ms)
    // will see the decision long before the 2000ms deadline.
    await sleep(150);
    await registry.publishDecision(approvalId, { approved: true });

    await expect(pending).resolves.toEqual({ approved: true });
    const resultEvent = recorder.events[1] as ToolApprovalResultEvent;
    expect(resultEvent.approval.status).toBe("approved");
  });

  it("rejects when append fails and leaves the record pending", async () => {
    const { fake, registry } = setup();
    const error = new Error("stream down");
    const append = vi.fn(async () => {
      throw error;
    });

    const handler = registry.createHandler({
      userId: USER_ID,
      sessionId: SESSION_ID,
      streamId: STREAM_ID,
      append,
      timeoutMs: 50,
    });
    await expect(handler(makeRequest())).rejects.toThrow("stream down");

    const approvalKey = fake.hset.mock.calls[0]?.[0];
    expect(approvalKey).toMatch(/^chat-approval:/);
    const approvalId = approvalKey!.slice("chat-approval:".length);
    const stored = await registry.getApproval(approvalId);
    expect(stored?.status).toBe("pending");
    expect(fake.del).not.toHaveBeenCalled();
  });

  it("deletes a corrupt decision key and keeps polling for the real decision", async () => {
    const { fake, recorder, registry } = setup();

    const pending = createHandler(registry, recorder, 2000)(makeRequest());
    const requestEvent =
      (await recorder.requestEvent) as ToolApprovalRequestEvent;
    const approvalId = requestEvent.approval.id;

    // Land the corrupt value before the handler's first poll, then publish
    // the real decision after that poll has dropped it.
    await fake.set(DECISION_KEY(approvalId), "this is not json");
    await sleep(150);
    await registry.publishDecision(approvalId, { approved: true });

    await expect(pending).resolves.toEqual({ approved: true });
    expect(fake.del).toHaveBeenNthCalledWith(1, DECISION_KEY(approvalId));
    expect(fake.del).toHaveBeenNthCalledWith(
      2,
      APPROVAL_KEY(approvalId),
      DECISION_KEY(approvalId),
    );
  });

  describe("tool session grants", () => {
    it("hasToolGrant is false initially, true after grantTool, false after revokeToolGrant", async () => {
      const { registry } = setup();

      await expect(
        registry.hasToolGrant(SESSION_ID, "web_search"),
      ).resolves.toBe(false);

      await registry.grantTool({
        sessionId: SESSION_ID,
        toolName: "web_search",
      });
      await expect(
        registry.hasToolGrant(SESSION_ID, "web_search"),
      ).resolves.toBe(true);

      await registry.revokeToolGrant(SESSION_ID, "web_search");
      await expect(
        registry.hasToolGrant(SESSION_ID, "web_search"),
      ).resolves.toBe(false);
    });

    it("grantTool stores the grant with a 24h session TTL", async () => {
      const { fake, registry } = setup();

      await registry.grantTool({
        sessionId: SESSION_ID,
        toolName: "web_search",
      });

      expect(fake.set).toHaveBeenCalledWith(
        GRANT_KEY(SESSION_ID, "web_search"),
        expect.any(String),
        "EX",
        GRANT_SESSION_TTL_SECONDS,
      );
      const payload = JSON.parse(
        fake.set.mock.calls[0]?.[1] ?? "{}",
      ) as Record<string, unknown>;
      expect(typeof payload.grantedAt).toBe("string");
    });
  });

  describe("tool arg overrides", () => {
    it("setToolOverride stores args and takeToolOverride returns and consumes them", async () => {
      const { fake, registry } = setup();
      const args = { query: "updated query", limit: 5 };

      await registry.setToolOverride({
        sessionId: SESSION_ID,
        toolName: "web_search",
        args,
      });
      expect(fake.set).toHaveBeenCalledWith(
        OVERRIDE_KEY(SESSION_ID, "web_search"),
        JSON.stringify(args),
        "EX",
        OVERRIDE_TTL_SECONDS,
      );

      await expect(
        registry.takeToolOverride(SESSION_ID, "web_search"),
      ).resolves.toEqual(args);
      await expect(
        registry.takeToolOverride(SESSION_ID, "web_search"),
      ).resolves.toBeNull();
    });

    it("takeToolOverride returns null for missing and corrupt values", async () => {
      const { fake, registry } = setup();

      await expect(
        registry.takeToolOverride(SESSION_ID, "web_search"),
      ).resolves.toBeNull();

      await fake.set(OVERRIDE_KEY(SESSION_ID, "web_search"), "not json");
      await expect(
        registry.takeToolOverride(SESSION_ID, "web_search"),
      ).resolves.toBeNull();
      expect(fake.del).toHaveBeenCalledWith(
        OVERRIDE_KEY(SESSION_ID, "web_search"),
      );
    });
  });

  describe("clarification requester", () => {
    const question = {
      id: "model",
      question: "Which model should I use?",
      type: "single_choice" as const,
      options: [
        { id: "gpt", label: "GPT" },
        { id: "claude", label: "Claude", recommended: true },
      ],
    };
    const request: ClarificationRequest = {
      title: "Model selection",
      questions: [question],
    };

    function createRequester(
      registry: ReturnType<typeof createApprovalRegistry>,
      recorder: ReturnType<typeof createClarificationRecorder>,
      timeoutMs?: number,
    ) {
      return registry.createClarificationRequester({
        userId: USER_ID,
        sessionId: SESSION_ID,
        streamId: STREAM_ID,
        append: recorder.append,
        timeoutMs,
      });
    }

    it("stores a pending clarification and appends a clarification_request event", async () => {
      const { fake, registry } = setup();
      const recorder = createClarificationRecorder();

      const pending = createRequester(registry, recorder, 50)(request);
      const requestEvent =
        (await recorder.requestEvent) as ClarificationRequestEvent;

      expect(requestEvent.type).toBe("clarification_request");
      expect(requestEvent.clarification).toMatchObject({
        id: expect.any(String),
        sessionId: SESSION_ID,
        title: "Model selection",
        questions: [question],
        status: "pending",
        requestedAt: expect.any(String),
      });

      const id = requestEvent.clarification.id;
      expect(fake.set).toHaveBeenCalledWith(
        CLARIFICATION_KEY(id),
        expect.any(String),
        "EX",
        CLARIFICATION_TTL_SECONDS,
      );
      const stored = JSON.parse(
        fake.set.mock.calls[0]?.[1] ?? "{}",
      ) as Record<string, unknown>;
      expect(stored).toMatchObject({
        id,
        userId: USER_ID,
        sessionId: SESSION_ID,
        streamId: STREAM_ID,
        title: "Model selection",
        questions: [question],
        status: "pending",
        requestedAt: expect.any(String),
      });

      await registry.publishClarificationResponse(id, {
        answers: {},
        skipped: [],
      });
      await expect(pending).resolves.toEqual({
        answers: {},
        skipped: [],
        timedOut: false,
      });
    });

    it("resolves with the published answers and appends an answered event", async () => {
      const { fake, registry } = setup();
      const recorder = createClarificationRecorder();

      const pending = createRequester(registry, recorder, 50)(request);
      const requestEvent =
        (await recorder.requestEvent) as ClarificationRequestEvent;
      const id = requestEvent.clarification.id;

      await registry.publishClarificationResponse(id, {
        answers: { model: "claude" },
        skipped: ["other"],
      });
      await expect(pending).resolves.toEqual({
        answers: { model: "claude" },
        skipped: ["other"],
        timedOut: false,
      });

      expect(fake.set).toHaveBeenCalledWith(
        CLARIFICATION_DECISION_KEY(id),
        expect.any(String),
        "EX",
        DECISION_TTL_SECONDS,
      );
      const resultEvent = recorder.events[1] as ClarificationResponseEvent;
      expect(resultEvent.type).toBe("clarification_response");
      expect(resultEvent.clarification).toMatchObject({
        id,
        status: "answered",
        resolvedAt: expect.any(String),
      });
      await expect(registry.getClarification(id)).resolves.toBeNull();
    });

    it("falls back to defaults when the decision payload is malformed", async () => {
      const { registry } = setup();
      const recorder = createClarificationRecorder();

      const pending = createRequester(registry, recorder, 50)(request);
      const requestEvent =
        (await recorder.requestEvent) as ClarificationRequestEvent;
      const id = requestEvent.clarification.id;

      await registry.publishClarificationResponse(
        id,
        { answers: "nope", skipped: "nope" } as never,
      );
      await expect(pending).resolves.toEqual({
        answers: {},
        skipped: [],
        timedOut: false,
      });
    });

    it("times out and appends a timed_out clarification_response event", async () => {
      const { registry } = setup();
      const recorder = createClarificationRecorder();

      const pending = createRequester(registry, recorder, 50)(request);
      const requestEvent =
        (await recorder.requestEvent) as ClarificationRequestEvent;
      const id = requestEvent.clarification.id;

      await expect(pending).resolves.toEqual({
        answers: {},
        skipped: [],
        timedOut: true,
      });

      const resultEvent = recorder.events[1] as ClarificationResponseEvent;
      expect(resultEvent.type).toBe("clarification_response");
      expect(resultEvent.clarification).toMatchObject({
        id,
        status: "timed_out",
        resolvedAt: expect.any(String),
      });
      await expect(registry.getClarification(id)).resolves.toBeNull();
    });

    it("ignores late publishes after resolution", async () => {
      const { registry } = setup();
      const recorder = createClarificationRecorder();

      const pending = createRequester(registry, recorder, 50)(request);
      const requestEvent =
        (await recorder.requestEvent) as ClarificationRequestEvent;
      const id = requestEvent.clarification.id;

      await registry.publishClarificationResponse(id, {
        answers: { model: "gpt" },
        skipped: [],
      });
      await expect(pending).resolves.toEqual({
        answers: { model: "gpt" },
        skipped: [],
        timedOut: false,
      });

      await registry.publishClarificationResponse(id, {
        answers: { model: "claude" },
        skipped: [],
      });
      await expect(registry.getClarification(id)).resolves.toBeNull();
    });

    it("getClarification exposes userId and status while pending, null when corrupt", async () => {
      const { fake, registry } = setup();
      const recorder = createClarificationRecorder();

      const pending = createRequester(registry, recorder, 50)(request);
      const requestEvent =
        (await recorder.requestEvent) as ClarificationRequestEvent;
      const id = requestEvent.clarification.id;

      await expect(registry.getClarification(id)).resolves.toEqual({
        userId: USER_ID,
        status: "pending",
      });

      await fake.set(CLARIFICATION_KEY(id), "not json");
      await expect(registry.getClarification(id)).resolves.toBeNull();

      await registry.publishClarificationResponse(id, {
        answers: {},
        skipped: [],
      });
      await pending;
    });
  });
});
