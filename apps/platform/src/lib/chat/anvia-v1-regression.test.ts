import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyClientStreamEvent,
  messagesToUIMessages,
  parseClientStreamEvent,
  type ClientInteraction,
  type ClientStreamEvent,
} from "@anvia/client";
import {
  assertAgentInteractionResponse,
  parseAgentInteractionRequest,
} from "@anvia/core/agent/interactions";
import type { Message } from "@anvia/core";
import { describe, expect, it } from "vitest";
import {
  ChatDataSchemas,
  ChatStreamMetadataSchema,
  type ChatDataMap,
  type ChatStreamMetadata,
} from "./client-data";
import {
  buildApprovalResponse,
  stageThenRespond,
} from "./interaction-response";
import {
  readChatMessageMeta,
  withChatMessageMeta,
} from "./message-metadata";
import {
  withCurrentRequestMetadata,
  type ChatRequestMetadata,
} from "./anvia-transport";

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(resolve(currentDir, file), "utf8");

const metadata: ChatStreamMetadata = {
  sessionId: "session-1",
  modelId: "deepseek/deepseek-v4-flash-0731",
  reasoningEffort: "max",
};

const requestMetadata: ChatRequestMetadata = {
  sessionId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  documentIds: [],
  modelId: metadata.modelId,
  reasoningEffort: "max",
  webSearchEnabled: false,
  imageGenerationEnabled: false,
  deepResearchEnabled: false,
  imageGenSettings: null,
};

const approvalRequest = parseAgentInteractionRequest({
  id: "interaction-1",
  type: "tool-approval",
  toolName: "generate_image",
  toolCallId: "tool-call-1",
  internalCallId: "internal-call-1",
  input: { prompt: "a calm landscape" },
});

function parseEvent(event: unknown) {
  return parseClientStreamEvent<ChatStreamMetadata, ChatDataMap>(event, {
    metadataSchema: ChatStreamMetadataSchema,
    dataSchemas: ChatDataSchemas,
  });
}

describe("Anvia v1 migration-wide platform contracts", () => {
  it("parses standard events, rich tool/file parts, and exact named data parts", () => {
    const runId = "run-1";
    const events: unknown[] = [
      { runId, type: "run_start", source: "agent", metadata },
      { runId, type: "message_start", messageId: "message-1", role: "assistant" },
      { runId, type: "text_start", messageId: "message-1", partId: "text-1" },
      { runId, type: "text_delta", messageId: "message-1", partId: "text-1", delta: "ready" },
      { runId, type: "text_end", messageId: "message-1", partId: "text-1", text: "ready" },
      {
        runId,
        type: "tool_call_start",
        messageId: "message-1",
        partId: "tool-1",
        toolCallId: "tool-call-1",
        toolName: "generate_image",
      },
      {
        runId,
        type: "tool_call_end",
        messageId: "message-1",
        partId: "tool-1",
        toolCallId: "tool-call-1",
        toolName: "generate_image",
        input: { prompt: "a calm landscape" },
      },
      {
        runId,
        type: "tool_result",
        messageId: "message-1",
        partId: "tool-1",
        toolCallId: "tool-call-1",
        toolName: "generate_image",
        input: { prompt: "a calm landscape" },
        result: {
          status: "success",
          output: { imageId: "image-1" },
          content: [
            { type: "text", text: "Generated image" },
            {
              type: "file",
              data: { type: "url", url: "https://cdn.example/image.png" },
              mediaType: "image/png",
              filename: "image.png",
            },
          ],
        },
      },
      {
        runId,
        type: "message_end",
        messageId: "message-1",
        parts: [
          { id: "text-1", type: "text", text: "ready" },
          {
            id: "image-1",
            type: "attachment",
            attachment: {
              id: "image-1",
              type: "image",
              url: "https://cdn.example/image.png",
              mediaType: "image/png",
            },
          },
        ],
      },
      {
        runId,
        type: "data",
        name: "queuedMessageApplied",
        data: { clientMessageId: "client-1", attachmentCount: 1 },
      },
      { runId, type: "run_end", status: "completed", text: "ready" },
    ];

    const parsed = events.map(parseEvent);
    expect(parsed.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "text_start",
      "text_delta",
      "text_end",
      "tool_call_start",
      "tool_call_end",
      "tool_result",
      "message_end",
      "data",
      "run_end",
    ]);
    expect(parsed[7]).toMatchObject({
      type: "tool_result",
      result: { status: "success", content: [{ type: "text" }, { type: "file" }] },
    });
    expect(parsed[8]).toMatchObject({
      type: "message_end",
      parts: [
        { type: "text", text: "ready" },
        { type: "attachment", attachment: { type: "image", mediaType: "image/png" } },
      ],
    });

    const startedMessages = applyClientStreamEvent(
      [],
      parsed[1] as ClientStreamEvent<ChatStreamMetadata, ChatDataMap>,
    );
    const uiMessages = applyClientStreamEvent(
      startedMessages,
      parsed[8] as ClientStreamEvent<ChatStreamMetadata, ChatDataMap>,
    );
    expect(uiMessages[0]?.parts).toEqual(parsed[8] && (parsed[8].type === "message_end" ? parsed[8].parts : []));
  });

  it("keeps data names and payloads exact, including rejection privacy", () => {
    expect(Object.keys(ChatDataSchemas).sort()).toEqual([
      "deepResearchProgress",
      "queuedMessageApplied",
    ]);
    expect(ChatDataSchemas.queuedMessageApplied.safeParse({
      clientMessageId: "client-1",
      attachmentCount: 2,
    })).toMatchObject({ success: true });
    expect(ChatDataSchemas.queuedMessageApplied.safeParse({
      clientMessageId: "client-1",
      attachmentCount: 2,
      prompt: "private prompt",
    })).toMatchObject({ success: false });

    const secret = "PRIVATE_ACTIVITY_PAYLOAD";
    const invalid = {
      runId: "run-1",
      type: "data",
      name: "deepResearchProgress",
      data: {
        phase: "researching",
        message: "Searching",
        prompt: secret,
      },
    };
    let error: unknown;
    try {
      parseEvent(invalid);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
  });

  it("derives a summary only from the native Anvia memory marker", () => {
    const marker = {
      anvia: { memoryCompaction: { version: 1, compactedMessageCount: 4 } },
    } as const;
    const nativeMessage = {
      role: "system",
      content: "The earlier conversation was compacted.",
      metadata: marker,
    } as Message;
    const uiSummary = messagesToUIMessages([nativeMessage])[0];
    expect(readChatMessageMeta(uiSummary?.metadata)).toMatchObject({
      kind: "summary",
      anvia: marker.anvia,
    });
    expect(readChatMessageMeta({ kind: "summary" })).toEqual({});
    expect(withChatMessageMeta({ kind: "summary" }, {})).toEqual({});
    expect(withChatMessageMeta(undefined, { anvia: marker.anvia })).toMatchObject(marker);
  });

  it("waits for staged native policy before submitting the exact interaction response", async () => {
    const response = buildApprovalResponse({ approved: true });
    assertAgentInteractionResponse(approvalRequest, response);
    const interaction = {
      request: approvalRequest,
      runId: "run-1",
      status: "pending",
    } satisfies ClientInteraction;
    const order: string[] = [];
    let release!: () => void;
    const stageBarrier = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const respond = async (input: { interactionId: string; response: unknown }) => {
      order.push("respond");
      expect(input).toEqual({ interactionId: approvalRequest.id, response });
    };
    const pending = stageThenRespond({
      interaction,
      response,
      policy: { grantScope: "session" },
      stage: async () => {
        order.push("stage");
        await stageBarrier;
        order.push("stage:done");
      },
      respond,
      inFlight: new Set(),
    });
    await Promise.resolve();
    expect(order).toEqual(["stage"]);
    release();
    await pending;
    expect(order).toEqual(["stage", "stage:done", "respond"]);
  });

  it("uses the native cursor for resume without a manual continuation snapshot or v0 bridge", () => {
    const request = {
      type: "messages" as const,
      messages: [{ role: "user" as const, content: "resume" }],
      resume: { streamId: "stream-1", after: 8 },
    };
    const serialized = withCurrentRequestMetadata(request, requestMetadata);
    expect(serialized).toEqual({ ...request, metadata: requestMetadata });
    expect(serialized).not.toHaveProperty("continuation");
    expect(serialized).not.toHaveProperty("recipe");
    expect(JSON.stringify(serialized)).not.toMatch(/humanInput|createRequest|ToolApproval|tool_approval_request/);

    const transport = source("anvia-transport.ts");
    expect(transport).toContain("request.resume");
    expect(transport).not.toMatch(/manual.*resume.*snapshot|resume.*messages\.slice/i);
  });
});
