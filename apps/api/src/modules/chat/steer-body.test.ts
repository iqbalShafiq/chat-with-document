import { describe, expect, it } from "vitest";
import {
  MAX_STEER_ATTACHMENTS,
  MAX_STEER_ATTACHMENT_BYTES,
  MAX_STEER_CLIENT_ID_CHARS,
  MAX_STEER_MESSAGES,
  MAX_STEER_SNIPPET_CHARS,
  MAX_STEER_TEXT_CHARS,
  parseSteerBody,
} from "./steer-body.js";

const validBody = {
  sessionId: "session-1",
  messages: [
    { clientMessageId: "msg-1", text: "follow up" },
    {
      clientMessageId: "msg-2",
      text: "with image",
      attachments: [{ mediaType: "image/png", data: "AAAA" }],
      contextSnippet: { text: "pinned", sourceRole: "user" },
    },
  ],
};

describe("parseSteerBody", () => {
  it("accepts a valid body", () => {
    expect(parseSteerBody(validBody)).toEqual(validBody);
  });

  it("rejects missing or empty sessionId", () => {
    expect(parseSteerBody({ ...validBody, sessionId: "" })).toBeNull();
    expect(parseSteerBody({ messages: validBody.messages })).toBeNull();
  });

  it("rejects empty messages and more than the cap", () => {
    expect(parseSteerBody({ ...validBody, messages: [] })).toBeNull();
    expect(
      parseSteerBody({
        ...validBody,
        messages: Array.from({ length: MAX_STEER_MESSAGES + 1 }, (_, i) => ({
          clientMessageId: `m-${i}`,
          text: "x",
        })),
      }),
    ).toBeNull();
  });

  it("rejects invalid clientMessageId and oversized text", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [{ clientMessageId: "", text: "x" }],
      }),
    ).toBeNull();
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          { clientMessageId: "m", text: "x".repeat(MAX_STEER_TEXT_CHARS + 1) },
        ],
      }),
    ).toBeNull();
  });

  it("rejects empty text without attachments", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [{ clientMessageId: "m", text: "   " }],
      }),
    ).toBeNull();
  });

  it("rejects more than the attachment count cap", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m",
            text: "x",
            attachments: Array.from(
              { length: MAX_STEER_ATTACHMENTS + 1 },
              () => ({ mediaType: "image/png", data: "AAAA" }),
            ),
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects attachment data longer than the byte cap", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m",
            text: "x",
            attachments: [
              {
                mediaType: "image/png",
                data: "A".repeat(MAX_STEER_ATTACHMENT_BYTES + 1),
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects clientMessageId longer than the cap", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m".repeat(MAX_STEER_CLIENT_ID_CHARS + 1),
            text: "x",
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects contextSnippet text longer than the cap", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m",
            text: "x",
            contextSnippet: {
              text: "y".repeat(MAX_STEER_SNIPPET_CHARS + 1),
              sourceRole: "user",
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects malformed attachments and snippets", () => {
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m",
            text: "x",
            attachments: [{ mediaType: "image/png" }],
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseSteerBody({
        ...validBody,
        messages: [
          {
            clientMessageId: "m",
            text: "x",
            contextSnippet: { text: "y", sourceRole: "system" },
          },
        ],
      }),
    ).toBeNull();
  });

  it("drops undefined optional fields", () => {
    const parsed = parseSteerBody({
      sessionId: "s",
      messages: [{ clientMessageId: "m", text: "x", attachments: undefined }],
    });
    expect(parsed?.messages[0]).toEqual({ clientMessageId: "m", text: "x" });
  });

  it("rejects non-object payloads", () => {
    expect(parseSteerBody(null)).toBeNull();
    expect(parseSteerBody("nope")).toBeNull();
    expect(parseSteerBody([])).toBeNull();
  });
});
