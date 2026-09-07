import { describe, expect, it } from "vitest";
import type { Message } from "@anvia/core";
import { stripUserAttachments } from "./strip-user-attachments.js";

describe("stripUserAttachments", () => {
  it("keeps a strict v1 string user message and its metadata", () => {
    const message = {
      role: "user",
      content: "plain prompt",
      metadata: { clientMessageId: "client-1" },
    } as Message;

    expect(stripUserAttachments(message)).toEqual(message);
  });

  it("keeps text parts while dropping strict v1 image and file parts", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        {
          type: "image",
          image: { type: "data", data: "aGVsbG8=" },
          mediaType: "image/png",
        },
        {
          type: "file",
          data: { type: "data", data: "aGVsbG8=" },
          mediaType: "application/pdf",
          filename: "brief.pdf",
        },
      ],
      metadata: { clientMessageId: "client-2" },
    } as Message;

    expect(stripUserAttachments(message)).toEqual({
      role: "user",
      content: [{ type: "text", text: "describe this" }],
      metadata: { clientMessageId: "client-2" },
    });
  });

  it("keeps a strict empty text part when an attachment-only prompt is stripped", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "file",
          data: { type: "data", data: "aGVsbG8=" },
          mediaType: "application/pdf",
        },
      ],
    } as Message;

    expect(stripUserAttachments(message)).toEqual({
      role: "user",
      content: [{ type: "text", text: "" }],
    });
  });

  it("returns non-user messages unchanged", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    } as Message;

    expect(stripUserAttachments(message)).toBe(message);
  });
});
