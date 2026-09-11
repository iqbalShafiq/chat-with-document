import { describe, expect, it } from "vitest";
import { parseUIMessage, type UIMessage, type UIMessagePart } from "@anvia/client";
import { finalizeInterruptedTools } from "./finalize-interrupted-tools.js";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

function tool(
  state: ToolPart["state"],
  overrides: Record<string, unknown> = {},
): ToolPart {
  const raw = {
    id: "part-1",
    type: "tool",
    toolName: "generate_image",
    toolCallId: "call-1",
    ...overrides,
    state,
    ...(state === "input-streaming"
      ? { input: overrides.input ?? "" }
      : state === "input-available"
        ? { input: overrides.input ?? {} }
        : state === "output-available"
          ? { input: overrides.input ?? {}, output: overrides.output ?? null }
          : {
              input: overrides.input ?? {},
              error: overrides.error ?? { message: "tool failed" },
            }),
  };
  const parsed = parseUIMessage({ id: "message-1", role: "assistant", parts: [raw] });
  const part = parsed.parts[0];
  if (!part || part.type !== "tool") {
    throw new Error("Expected Anvia client parser to return a tool part");
  }
  return part;
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
    if (parts[0]?.state === "error") {
      expect(parts[0].error.message).toMatch(/stopped/i);
    }
    expect(parts[1]?.state).toBe("error");
    expect(parts[2]?.state).toBe("output-available");
    if (parts[2]?.state === "output-available") {
      expect(parts[2].output).toEqual({ ok: true });
    }
  });

  it("marks an output-available still_running part as stopped", () => {
    const messages: UIMessage[] = [
      assistant([tool("output-available", { output: { status: "still_running", toolCallId: "c1" } })]),
    ];
    const next = finalizeInterruptedTools(messages);
    const parts = next[0]!.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    expect(parts[0]?.state).toBe("error");
    if (parts[0]?.state === "error") {
      expect(parts[0].error.message).toMatch(/stopped/i);
    }
  });

  it("leaves a settled tool output unchanged", () => {
    const messages: UIMessage[] = [
      assistant([tool("output-available", { output: { rows: [1] } })]),
    ];
    expect(finalizeInterruptedTools(messages)).toBe(messages);
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
