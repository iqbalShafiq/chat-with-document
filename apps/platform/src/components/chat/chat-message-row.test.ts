import { parseUIMessage } from "@anvia/client";
import { describe, expect, it } from "vitest";
import { isRenderablePart, shouldShowMessageActions } from "./chat-message-row";

describe("strict Anvia v1 message part presentation", () => {
  it("keeps source, typed data, bounded error, and non-image attachment parts visible", () => {
    const message = parseUIMessage({
      id: "assistant-1",
      role: "assistant",
      parts: [
        { id: "source-1", type: "source", source: { type: "url", url: "https://example.com/source", title: "Source" } },
        { id: "data-1", type: "data", name: "queuedMessageApplied", data: { clientMessageId: "message-1", attachmentCount: 0 } },
        { id: "error-1", type: "error", error: { message: "The run failed", code: "CHAT_RUN_FAILED" } },
        { id: "file-1", type: "attachment", attachment: { id: "attachment-1", type: "document", name: "report.pdf" } },
      ],
    });

    expect(message.parts.map((part) => isRenderablePart(part, message.role))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("hides Deep Research progress data parts from the transcript", () => {
    const message = parseUIMessage({
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          id: "progress-1",
          type: "data",
          name: "deepResearchProgress",
          data: {
            phase: "researching",
            message: "Searching approved sources",
            activities: [
              {
                id: "activity-1",
                kind: "retrieval",
                label: "Searching the web",
                status: "active",
              },
            ],
            stats: { retrievalCalls: 2, retrievalLimit: 4 },
          },
        },
        {
          id: "ack-1",
          type: "data",
          name: "queuedMessageApplied",
          data: { clientMessageId: "message-1", attachmentCount: 0 },
        },
      ],
    });

    expect(message.parts.map((part) => isRenderablePart(part, message.role))).toEqual([
      false,
      true,
    ]);
  });

  it("hides assistant copy/reply while the live bubble is still streaming", () => {
    const message = parseUIMessage({
      id: "assistant-live",
      role: "assistant",
      parts: [{ id: "text-1", type: "text", text: "partial answer" }],
    });
    expect(
      shouldShowMessageActions(message, true, "streaming", "assistant-live"),
    ).toBe(false);
    expect(
      shouldShowMessageActions(message, true, "waiting", "assistant-live"),
    ).toBe(false);
    expect(
      shouldShowMessageActions(message, true, "ready", "assistant-live"),
    ).toBe(true);
  });
});
