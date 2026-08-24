import { parseUIMessage } from "@anvia/client";
import { describe, expect, it } from "vitest";
import { isRenderablePart } from "./chat-message-row";

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
});
