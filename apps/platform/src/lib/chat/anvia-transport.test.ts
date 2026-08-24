import type { ClientStreamRequest } from "@anvia/client";
import { EventStreamHttpError } from "@anvia/client/transport";
import { describe, expect, it } from "vitest";
import {
  createAnviaChatTransport,
  isAuthFailure,
  isRunActiveConflict,
  requireChatReasoningEffort,
  stopChatPreservingMessages,
  type ChatRequestMetadata,
} from "./anvia-transport";

type TestRequest = ClientStreamRequest<ChatRequestMetadata>;

const metadata: ChatRequestMetadata = {
  sessionId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  documentIds: ["550e8400-e29b-41d4-a716-446655440000"],
  modelId: "deepseek/deepseek-v4-flash-0731",
  reasoningEffort: "max",
  webSearchEnabled: true,
  imageGenerationEnabled: false,
  deepResearchEnabled: true,
  imageGenSettings: null,
};

const message = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "Summarize the report." }],
};

const approvalResponse = {
  type: "tool-approval" as const,
  approved: true,
};

const questionResponse = {
  type: "tool-question" as const,
  answers: [{ questionId: "style", value: "concise" }],
};

function responseFor(
  frames: readonly Record<string, unknown>[],
  headers: Record<string, string> = {
    "content-type": "application/x-ndjson",
    "x-anvia-stream-protocol": "anvia.client.v3",
  },
): Response {
  return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
    status: 200,
    headers,
  });
}

function validFrames(streamId = "stream-1") {
  return [
    {
      type: "stream_start",
      protocol: "anvia.client.v3",
      streamId,
      eventId: 0,
      resumable: true,
    },
    {
      type: "stream_event",
      streamId,
      eventId: 1,
      event: { type: "run_start", runId: "run-1", source: "agent" },
    },
    {
      type: "stream_event",
      streamId,
      eventId: 2,
      event: { type: "run_end", runId: "run-1", status: "completed" },
    },
    { type: "stream_end", streamId, eventId: 2, status: "completed" },
  ] as const;
}

function validFramesAfter(after: number, streamId = "stream-1") {
  return validFrames(streamId).map((frame) => {
    if (frame.type === "stream_start") return frame;
    return { ...frame, eventId: frame.eventId + after };
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function transportWithCapture(
  currentMetadata: () => ChatRequestMetadata,
  response = responseFor(validFrames()),
) {
  let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { input, init };
    return response;
  };
  const transport = createAnviaChatTransport({
    endpoint: "/api/chat",
    getRequestMetadata: () => currentMetadata(),
    fetch,
  });
  return { transport, getCaptured: () => captured };
}

describe("Anvia v1 HTTP transport", () => {
  it("requires an explicit supported reasoning effort", () => {
    expect(requireChatReasoningEffort("max")).toBe("max");
    expect(requireChatReasoningEffort(null)).toBeNull();
    expect(() => requireChatReasoningEffort("automatic")).toThrow(
      "Chat reasoning effort is invalid.",
    );
  });

  it("uses authenticated JSON requests without provider secrets", async () => {
    const { transport, getCaptured } = transportWithCapture(() => metadata);
    const request: TestRequest = { type: "messages", messages: [message] };
    await collect(transport.send({ request }));

    const captured = getCaptured();
    expect(captured?.input).toBe("/api/chat");
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.credentials).toBe("include");
    expect(new Headers(captured?.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ type: "messages", messages: [message], metadata });
    expect(JSON.stringify(body)).not.toContain("sk-");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("sessionId");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("promptMessage");
  });

  it("reads current settings at send time and replaces stale request metadata", async () => {
    let current = metadata;
    const { transport, getCaptured } = transportWithCapture(() => current);
    current = {
      ...metadata,
      sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      documentIds: [],
      modelId: "openai/gpt-5-mini",
      reasoningEffort: "high",
      webSearchEnabled: false,
      imageGenerationEnabled: true,
      deepResearchEnabled: false,
      imageGenSettings: { modelId: "gpt-image-1", aspectRatio: "16:9" },
    };
    const stale = {
      type: "messages" as const,
      messages: [message],
      metadata: { ...metadata, providerSecret: "sk-old" },
    } as TestRequest;
    await collect(transport.send({ request: stale }));

    const body = JSON.parse(String(getCaptured()?.init?.body)) as Record<string, unknown>;
    expect(body.metadata).toEqual(current);
    expect(JSON.stringify(body)).not.toContain("sk-old");
  });

  it("fails instead of defaulting when current policy metadata is impossible", async () => {
    const { transport } = transportWithCapture(() => ({
      ...metadata,
      sessionId: "",
    }));
    await expect(
      collect(transport.send({ request: { type: "messages", messages: [message] } })),
    ).rejects.toThrow("Chat request metadata is invalid.");
  });

  it("preserves canonical interaction responses and cursors", async () => {
    const { transport, getCaptured } = transportWithCapture(
      () => metadata,
      responseFor(validFramesAfter(12)),
    );
    const request: TestRequest = {
      type: "interaction_response",
      interactionId: "interaction-1",
      response: questionResponse,
      metadata: { ...metadata, stale: true } as ChatRequestMetadata,
      resume: { streamId: "stream-1", after: 12 },
    };
    await collect(transport.send({ request }));

    const body = JSON.parse(String(getCaptured()?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      type: "interaction_response",
      interactionId: "interaction-1",
      response: questionResponse,
      metadata,
      resume: { streamId: "stream-1", after: 12 },
    });
    expect(body).not.toHaveProperty("grantScope");
    expect(body).not.toHaveProperty("overrideArgs");
    expect(body).not.toHaveProperty("continuation");
    expect(body).not.toHaveProperty("recipe");

    const approvalRequest: TestRequest = {
      type: "interaction_response",
      interactionId: "interaction-2",
      response: approvalResponse,
      resume: { streamId: "stream-1", after: 0 },
    };
    const approvalTransport = transportWithCapture(() => metadata);
    await collect(approvalTransport.transport.send({ request: approvalRequest }));
    const approvalBody = JSON.parse(
      String(approvalTransport.getCaptured()?.init?.body),
    ) as Record<string, unknown>;
    expect(approvalBody.resume).toEqual({ streamId: "stream-1", after: 0 });
    expect(approvalBody.response).toEqual(approvalResponse);
  });

  it("rejects a response without the exact v3 protocol header", async () => {
    const { transport } = transportWithCapture(
      () => metadata,
      responseFor(validFrames(), { "content-type": "application/x-ndjson" }),
    );
    await expect(collect(transport.send({
      request: { type: "messages", messages: [message] },
    }))).rejects.toThrow(/protocol/i);
  });

  it("rejects gaps, wrong stream identity, and terminal mismatches", async () => {
    for (const frames of [
      validFrames().map((frame) => frame.type === "stream_event" && frame.eventId === 2
        ? { ...frame, eventId: 3 }
        : frame),
      validFrames().map((frame) => frame.type === "stream_event" && frame.eventId === 1
        ? { ...frame, streamId: "other-stream" }
        : frame),
      validFrames().map((frame) => frame.type === "stream_end"
        ? { ...frame, eventId: 1 }
        : frame),
    ]) {
      const { transport } = transportWithCapture(() => metadata, responseFor(frames));
      await expect(collect(transport.send({
        request: { type: "messages", messages: [message] },
      }))).rejects.toThrow();
    }
  });

  it("validates named data events through the Anvia parser", async () => {
    const frames = validFrames();
    const dataFrames = [
      frames[0],
      frames[1],
      {
        type: "stream_event" as const,
        streamId: "stream-1",
        eventId: 2,
        event: {
          type: "data" as const,
          name: "queuedMessageApplied" as const,
          runId: "run-1",
          data: { clientMessageId: "client-1", attachmentCount: 1 },
        },
      },
      { ...frames[2], eventId: 3 },
      { ...frames[3], eventId: 3 },
    ];
    const { transport } = transportWithCapture(
      () => metadata,
      responseFor(dataFrames),
    );
    await expect(
      collect(transport.send({ request: { type: "messages", messages: [message] } })),
    ).resolves.toHaveLength(5);

    const invalid = dataFrames.map((frame) =>
      frame.type === "stream_event" && frame.event.type === "data"
        ? {
            ...frame,
            event: { ...frame.event, name: "legacy_raw_event" },
          }
        : frame,
    );
    const invalidTransport = transportWithCapture(
      () => metadata,
      responseFor(invalid),
    );
    await expect(
      collect(
        invalidTransport.transport.send({
          request: { type: "messages", messages: [message] },
        }),
      ),
    ).rejects.toThrow();
  });

  it("keeps HTTP ownership errors inspectable without creating a user-facing body mapper", async () => {
    const secret = "TOP_SECRET_PROVIDER_BODY";
    const response = new Response(JSON.stringify({ code: "RUN_ACTIVE", secret }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
    const { transport } = transportWithCapture(() => metadata, response);
    let error: unknown;
    try {
      await collect(transport.send({ request: { type: "messages", messages: [message] } }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EventStreamHttpError);
    // The classifier intentionally rejects bodies containing unrelated fields;
    // route-level handling must never inspect or expose provider error data.
    expect(isRunActiveConflict(error)).toBe(false);
    expect(isRunActiveConflict(new Error(secret))).toBe(false);
  });

  it("recognizes the bounded RUN_ACTIVE response emitted by the API", async () => {
    const response = new Response(JSON.stringify({
      error: "Session is already processing in another tab",
      code: "RUN_ACTIVE",
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
    const { transport } = transportWithCapture(() => metadata, response);
    let error: unknown;
    try {
      await collect(transport.send({ request: { type: "messages", messages: [message] } }));
    } catch (caught) {
      error = caught;
    }

    expect(isRunActiveConflict(error)).toBe(true);
  });

  it("classifies only a 401 transport error as an auth failure", async () => {
    const secret = "TOP_SECRET_AUTH_BODY";
    const response = new Response(JSON.stringify({ secret }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const { transport } = transportWithCapture(() => metadata, response);
    let error: unknown;
    try {
      await collect(transport.send({ request: { type: "messages", messages: [message] } }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EventStreamHttpError);
    expect(isAuthFailure(error)).toBe(true);
    expect(JSON.stringify({ message: "safe" })).not.toContain(secret);
    expect(isAuthFailure(new Error(secret))).toBe(false);
  });

  it("bounds the RUN_ACTIVE body classifier before parsing", async () => {
    const oversized = new Response(`{"code":"RUN_ACTIVE","padding":"${"x".repeat(4096)}"}`, {
      status: 409,
    });
    const { transport } = transportWithCapture(() => metadata, oversized);
    let error: unknown;
    try {
      await collect(transport.send({ request: { type: "messages", messages: [message] } }));
    } catch (caught) {
      error = caught;
    }
    expect(isRunActiveConflict(error)).toBe(false);
  });

  it("preserves finalized messages when stopping a v1 controller", () => {
    const messages = [{ state: "input-available" }, { state: "output-available" }];
    let current = messages;
    let stopped = false;
    const controller = {
      get messages() {
        return current;
      },
      stop() {
        stopped = true;
      },
      setMessages(next: typeof messages) {
        current = next;
      },
      resetCalled: false,
    };
    stopChatPreservingMessages(controller, (value) =>
      value.map((item) => ({ ...item, state: "error" })),
    );
    expect(stopped).toBe(true);
    expect(controller.resetCalled).toBe(false);
    expect(current).toEqual([
      { state: "error" },
      { state: "error" },
    ]);
  });

});
