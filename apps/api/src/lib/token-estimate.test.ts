import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from "./token-estimate.js";

describe("estimateTextTokens", () => {
  it("uses ceil(chars/4) with a minimum of 1", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a")).toBe(1);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
    expect(estimateTextTokens("x".repeat(400))).toBe(100);
  });
});

describe("estimateMessageTokens", () => {
  it("counts text parts plus overhead", () => {
    const message = { role: "user", content: [{ type: "text", text: "a".repeat(400) }] };
    expect(estimateMessageTokens(message)).toBe(4 + 100);
  });

  it("counts tool_result nested text parts", () => {
    const message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "c1",
          content: [{ type: "text", text: "a".repeat(400) }],
        },
      ],
    };
    expect(estimateMessageTokens(message)).toBe(4 + 100);
  });

  it("counts images as fixed tokens", () => {
    const message = { role: "user", content: [{ type: "image", url: "x" }] };
    expect(estimateMessageTokens(message)).toBe(4 + 85);
  });

  it("handles string content (system messages)", () => {
    expect(estimateMessageTokens({ role: "system", content: "a".repeat(400) })).toBe(4 + 100);
  });

  it("is zero for non-objects", () => {
    expect(estimateMessageTokens(null)).toBe(0);
    expect(estimateMessageTokens("nope")).toBe(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("sums messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "a".repeat(400) }] },
      { role: "assistant", content: [{ type: "text", text: "b".repeat(400) }] },
    ];
    expect(estimateMessagesTokens(messages)).toBe(208);
  });
});
