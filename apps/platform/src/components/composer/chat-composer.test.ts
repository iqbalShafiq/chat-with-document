import { parseUIMessage } from "@anvia/client";
import { describe, expect, it } from "vitest";
import { composerActionForStatus, isActiveComposerStatus } from "./chat-composer";

describe("Anvia v1 composer status contract", () => {
  it.each([
    ["submitted", true],
    ["streaming", true],
  ] as const)("treats %s as an active editable run", (status, expected) => {
    expect(isActiveComposerStatus(status)).toBe(expected);
  });

  it.each([
    ["ready", true, "send"],
    ["submitted", true, "queue"],
    ["streaming", true, "queue"],
    ["submitted", false, "stop"],
    ["streaming", false, "stop"],
    ["waiting", true, "inactive"],
    ["error", true, "send"],
    ["error", false, "inactive"],
    ["ready", false, "inactive"],
  ] as const)("maps %s with content=%s to %s", (status, hasContent, action) => {
    expect(composerActionForStatus(status, hasContent)).toBe(action);
  });

  it("uses the installed Anvia client parser for strict v1 UI messages", () => {
    const message = parseUIMessage({
      id: "assistant-1",
      role: "assistant",
      parts: [
        { id: "text-1", type: "text", text: "Hello" },
        {
          id: "tool-1",
          type: "tool",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "output-available",
          input: { query: "Anvia v1" },
          output: { results: [] },
        },
      ],
    });

    expect(message.parts[1]).toMatchObject({
      type: "tool",
      state: "output-available",
      toolName: "web_search",
    });
  });
});
