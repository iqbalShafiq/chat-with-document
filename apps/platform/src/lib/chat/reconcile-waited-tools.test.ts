import { describe, expect, it } from "vitest";
import { parseUIMessage, type UIMessage, type UIMessagePart } from "@anvia/client";
import { reconcileWaitedTools } from "./reconcile-waited-tools.js";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

function toolPart(input: {
  id: string;
  toolName: string;
  toolCallId: string;
  output?: unknown;
  toolInput?: unknown;
  state?: ToolPart["state"];
}): ToolPart {
  const state = input.state ?? "output-available";
  const raw = {
    id: input.id,
    type: "tool",
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    input: input.toolInput ?? {},
    ...(state === "output-available" ? { output: input.output ?? null } : {}),
    state,
  };
  const parsed = parseUIMessage({ id: "m-1", role: "assistant", parts: [raw] });
  const part = parsed.parts[0];
  if (!part || part.type !== "tool") throw new Error("expected a tool part");
  return part;
}

function assistant(parts: UIMessagePart[]): UIMessage {
  return { id: "a1", role: "assistant", parts };
}

const stillRunning = (toolCallId: string) => ({
  type: "json",
  value: { status: "still_running", toolCallId },
});

describe("reconcileWaitedTools", () => {
  it("settles a waited tool card from the await result instead of leaving it waiting", () => {
    const messages: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          output: stillRunning("call-1"),
        }),
        toolPart({
          id: "p-2",
          toolName: "await_tool_call",
          toolCallId: "call-2",
          toolInput: { toolCallId: "call-1" },
          output: { type: "json", value: { query: "Anvia docs", answer: "found" } },
        }),
      ]),
    ];

    const next = reconcileWaitedTools(messages);
    const parts = next[0]!.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    expect(parts[0]?.state).toBe("output-available");
    if (parts[0]?.state === "output-available") {
      expect(parts[0].output).toEqual({ query: "Anvia docs", answer: "found" });
    }
  });

  it("maps the await result through its toolCallId argument, not just order", () => {
    const messages: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_fetch",
          toolCallId: "call-1",
          output: stillRunning("call-1"),
        }),
        toolPart({
          id: "p-2",
          toolName: "web_search",
          toolCallId: "call-9",
          output: stillRunning("call-9"),
        }),
        toolPart({
          id: "p-3",
          toolName: "await_tool_call",
          toolCallId: "call-3",
          toolInput: { toolCallId: "call-9" },
          output: { type: "json", value: { results: ["only for nine"] } },
        }),
      ]),
    ];

    const next = reconcileWaitedTools(messages);
    const parts = next[0]!.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    // call-1 was never awaited, so it stays as it was for finalize to handle.
    expect(parts[0]?.state === "output-available" && parts[0].output).toEqual(
      stillRunning("call-1"),
    );
    if (parts[1]?.state === "output-available") {
      expect(parts[1].output).toEqual({ results: ["only for nine"] });
    }
  });

  it("marks a cancelled wait as an error instead of a result", () => {
    const messages: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "generate_image",
          toolCallId: "call-1",
          output: stillRunning("call-1"),
        }),
        toolPart({
          id: "p-2",
          toolName: "cancel_tool_call",
          toolCallId: "call-2",
          toolInput: { toolCallId: "call-1" },
          output: { type: "json", value: { status: "cancelled", toolCallId: "call-1" } },
        }),
      ]),
    ];

    const next = reconcileWaitedTools(messages);
    const first = next[0]!.parts[0];
    expect(first?.type === "tool" && first.state).toBe("output-available");
    if (first?.type === "tool" && first.state === "output-available") {
      expect(first.output).toEqual({ status: "cancelled", toolCallId: "call-1" });
    }
  });

  it("settles a tool that returns a plain string report", () => {
    // A text-only tool such as deep_research returns its report bare, not in a
    // { type, value } envelope, so primitives must survive unwrapping.
    const report = "Deep Research report: risk one, risk two.";
    const messages: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "deep_research",
          toolCallId: "call-1",
          output: stillRunning("call-1"),
        }),
        toolPart({
          id: "p-2",
          toolName: "await_tool_call",
          toolCallId: "call-2",
          toolInput: { toolCallId: "call-1" },
          output: report,
        }),
      ]),
    ];

    const next = reconcileWaitedTools(messages);
    const first = next[0]!.parts[0];
    expect(first?.type === "tool" && first.state).toBe("output-available");
    if (first?.type === "tool" && first.state === "output-available") {
      expect(first.output).toBe(report);
    }
  });

  it("leaves an unfinished wait for the finalizer unless asked to mark it", () => {
    const messages: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          output: stillRunning("call-1"),
        }),
      ]),
    ];

    // Without markUnfinished the card is left for finalizeInterruptedTools.
    expect(reconcileWaitedTools(messages)).toBe(messages);

    const marked = reconcileWaitedTools(messages, { markUnfinished: true });
    const first = marked[0]!.parts[0];
    expect(first?.type === "tool" && first.state).toBe("error");
  });

  it("ignores a still-running checkpoint from another await", () => {
    const messages: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          output: stillRunning("call-1"),
        }),
        toolPart({
          id: "p-2",
          toolName: "await_tool_call",
          toolCallId: "call-2",
          toolInput: { toolCallId: "call-1" },
          output: stillRunning("call-1"),
        }),
      ]),
    ];

    expect(reconcileWaitedTools(messages)).toBe(messages);
  });

  it("returns the same array when nothing was waited on", () => {
    const messages: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          output: { results: ["done"] },
        }),
      ]),
    ];
    expect(reconcileWaitedTools(messages)).toBe(messages);
  });
});