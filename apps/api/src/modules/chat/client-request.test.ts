import { describe, expect, it } from "vitest";
import {
  ChatRequestError,
  parseChatClientRequest,
  type ChatRequestMetadata,
} from "./client-request.js";

const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const DOCUMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const STREAM_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

const metadata: ChatRequestMetadata = {
  sessionId: SESSION_ID,
  documentIds: [DOCUMENT_ID],
  modelId: "deepseek/deepseek-v4-flash-0731",
  reasoningEffort: "max",
  webSearchEnabled: true,
  imageGenerationEnabled: false,
  deepResearchEnabled: true,
  imageGenSettings: null,
};

const userMessage = {
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

function messagesBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "messages",
    messages: [userMessage],
    metadata,
    ...overrides,
  };
}

function responseBody(response: unknown = approvalResponse, overrides: Record<string, unknown> = {}) {
  return {
    type: "interaction_response",
    interactionId: "interaction-1",
    response,
    metadata,
    ...overrides,
  };
}

function expectCode(value: unknown, code: ChatRequestError["code"]): void {
  expect(value).toBeInstanceOf(ChatRequestError);
  expect((value as ChatRequestError).code).toBe(code);
}

describe("parseChatClientRequest", () => {
  it("parses an official v1 messages request with strict product metadata", () => {
    const parsed = parseChatClientRequest(messagesBody());

    expect(parsed).toMatchObject({
      kind: "messages",
      messages: [userMessage],
      metadata,
    });
  });

  it("parses native approval and question interaction responses", () => {
    expect(parseChatClientRequest(responseBody())).toMatchObject({
      kind: "interaction_response",
      interactionId: "interaction-1",
      response: approvalResponse,
      metadata,
    });
    expect(parseChatClientRequest(responseBody(questionResponse))).toMatchObject({
      kind: "interaction_response",
      response: questionResponse,
    });
  });

  it("classifies a cursor request as a subscription for either official union member", () => {
    const cursor = { streamId: STREAM_ID, after: 12 };

    expect(parseChatClientRequest(messagesBody({ resume: cursor }))).toMatchObject({
      kind: "resume",
      cursor,
      metadata,
    });
    expect(parseChatClientRequest(responseBody(approvalResponse, { resume: cursor }))).toMatchObject({
      kind: "resume",
      cursor,
      metadata,
    });
  });

  it("rejects v0 top-level fields and mixed request members", () => {
    for (const body of [
      messagesBody({ sessionId: SESSION_ID }),
      messagesBody({ model: "deepseek/deepseek-v4-flash-0731" }),
      messagesBody({ stream: true }),
      messagesBody({ promptMessage: userMessage }),
      messagesBody({ approval: { approved: true } }),
      messagesBody({ interactionId: "interaction-1" }),
      responseBody(approvalResponse, { messages: [userMessage] }),
      responseBody(approvalResponse, { answers: { style: "concise" } }),
    ]) {
      expect(() => parseChatClientRequest(body)).toThrowError(ChatRequestError);
      try {
        parseChatClientRequest(body);
      } catch (error) {
        expectCode(error, "INVALID_CLIENT_REQUEST");
      }
    }
  });

  it("rejects missing, incomplete, unknown, and malformed product metadata", () => {
    const invalidMetadata: Array<{ value: unknown; code: ChatRequestError["code"] }> = [
      { value: undefined, code: "INVALID_REQUEST_METADATA" },
      { value: { ...metadata, unknown: true }, code: "INVALID_REQUEST_METADATA" },
      { value: { ...metadata, sessionId: "" }, code: "INVALID_REQUEST_METADATA" },
      { value: { ...metadata, sessionId: "not-a-uuid" }, code: "INVALID_REQUEST_METADATA" },
      {
        value: { ...metadata, documentIds: Array.from({ length: 101 }, (_, index) => `${DOCUMENT_ID}-${index}`) },
        code: "INVALID_REQUEST_METADATA",
      },
      { value: { ...metadata, documentIds: ["not-a-uuid"] }, code: "INVALID_REQUEST_METADATA" },
      { value: { ...metadata, modelId: " " }, code: "INVALID_REQUEST_METADATA" },
      { value: { ...metadata, reasoningEffort: 4 }, code: "INVALID_REQUEST_METADATA" },
      { value: { ...metadata, webSearchEnabled: "true" }, code: "INVALID_REQUEST_METADATA" },
      { value: { ...metadata, imageGenSettings: undefined }, code: "INVALID_CLIENT_REQUEST" },
      { value: { ...metadata, imageGenSettings: { modelId: "" } }, code: "INVALID_IMAGE_SETTINGS" },
      { value: { ...metadata, imageGenSettings: { n: 0 } }, code: "INVALID_IMAGE_SETTINGS" },
      { value: { ...metadata, imageGenSettings: { n: 11 } }, code: "INVALID_IMAGE_SETTINGS" },
      { value: { ...metadata, imageGenSettings: { unsupported: true } }, code: "INVALID_IMAGE_SETTINGS" },
      {
        value: { ...metadata, imageGenerationEnabled: false, imageGenSettings: { modelId: "gpt-image-1" } },
        code: "INVALID_IMAGE_SETTINGS",
      },
    ];

    for (const candidate of invalidMetadata) {
      expect(() => parseChatClientRequest(messagesBody({ metadata: candidate.value }))).toThrowError(
        ChatRequestError,
      );
      try {
        parseChatClientRequest(messagesBody({ metadata: candidate.value }));
      } catch (error) {
        expectCode(error, candidate.code);
      }
    }
  });

  it("preserves an explicit null image settings value", () => {
    const parsed = parseChatClientRequest(messagesBody());
    expect(parsed.metadata.imageGenSettings).toBeNull();
  });

  it("rejects malformed official messages and invalid final message semantics", () => {
    const invalidBodies = [
      messagesBody({ messages: [] }),
      messagesBody({ messages: [{ role: "assistant", content: "already answered" }] }),
      messagesBody({ messages: [{ role: "user", content: [{ type: "unknown", value: "x" }] }] }),
      messagesBody({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }, { role: "system", content: "no" }] }),
    ];

    for (const body of invalidBodies) {
      expect(() => parseChatClientRequest(body)).toThrowError(ChatRequestError);
    }
  });

  it("rejects invalid cursors before any route side effect", () => {
    for (const resume of [
      { streamId: "", after: 0 },
      { streamId: STREAM_ID, after: -1 },
      { streamId: STREAM_ID, after: 1.5 },
      { streamId: STREAM_ID, after: Number.MAX_SAFE_INTEGER + 1 },
      { streamId: STREAM_ID, after: 0, extra: true },
    ]) {
      expect(() => parseChatClientRequest(messagesBody({ resume }))).toThrowError(ChatRequestError);
      try {
        parseChatClientRequest(messagesBody({ resume }));
      } catch (error) {
        expectCode(error, "INVALID_CLIENT_REQUEST");
      }
    }
  });

  it("maps official parser failures to bounded safe errors without prompt or tool input", () => {
    const secretPrompt = "TOP_SECRET_PROMPT_7c9e6679";
    const secretInput = "TOP_SECRET_TOOL_INPUT_3fa85f64";
    const body = messagesBody({
      messages: [{ role: "user", content: [{ type: "unknown", text: secretPrompt, input: secretInput }] }],
    });

    let error: unknown;
    try {
      parseChatClientRequest(body);
    } catch (caught) {
      error = caught;
    }
    expectCode(error, "INVALID_CLIENT_REQUEST");
    expect(JSON.stringify(error)).not.toContain(secretPrompt);
    expect(JSON.stringify(error)).not.toContain(secretInput);
  });
});
