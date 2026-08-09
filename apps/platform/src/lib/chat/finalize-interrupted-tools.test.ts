import { describe, expect, it } from "vitest";
import type { UIMessage, UIMessagePart } from "@anvia/react";
import { finalizeInterruptedTools } from "./finalize-interrupted-tools.js";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

function tool(
  state: ToolPart["state"],
  overrides: Partial<ToolPart> = {},
): ToolPart {
  return {
    id: "part-1",
    type: "tool",
    toolName: "generate_image",
    toolCallId: "call-1",
    state,
    ...overrides,
  };
}

function assistant(parts: UIMessagePart[]): UIMessage {
  return { id: "a1", role: "assistant", parts };
}

describe("finalizeInterruptedTools", () => {
  it("marks input-available and input-streaming tools as error", () => {
    const messages: UIMessage[] = [
      assistant([
        { id: "t", type: "text", text: "hi" },
        tool("input-available"),
        tool("input-streaming", { id: "part-2", toolCallId: "call-2" }),
        tool("output-available", {
          id: "part-3",
          toolCallId: "call-3",
          output: { ok: true },
        }),
      ]),
    ];

    const next = finalizeInterruptedTools(messages);
    const parts = next[0]!.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    expect(parts[0]?.state).toBe("error");
    expect(parts[0]?.error?.message).toMatch(/stopped/i);
    expect(parts[1]?.state).toBe("error");
    expect(parts[2]?.state).toBe("output-available");
    expect(parts[2]?.output).toEqual({ ok: true });
  });

  it("returns the same array reference when nothing changes", () => {
    const messages: UIMessage[] = [
      assistant([tool("output-available", { output: 1 })]),
      { id: "u1", role: "user", parts: [{ id: "t", type: "text", text: "x" }] },
    ];
    expect(finalizeInterruptedTools(messages)).toBe(messages);
  });

  it("leaves already-errored tools unchanged", () => {
    const messages: UIMessage[] = [
      assistant([
        tool("error", { error: { message: "boom" } }),
      ]),
    ];
    const next = finalizeInterruptedTools(messages);
    expect(next).toBe(messages);
  });
});
