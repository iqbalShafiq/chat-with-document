import { describe, expect, it } from "vitest";
import { parseUIMessage, type UIMessage, type UIMessagePart } from "@anvia/client";
import { finalizeInterruptedTools, settleStoppedRunTools, stillOpenToolCards } from "./finalize-interrupted-tools.js";

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

  it("uses a caller-supplied reason for a failed run", () => {
    const messages: UIMessage[] = [
      assistant([
        tool("input-available"),
        tool("output-available", {
          id: "part-2",
          toolCallId: "call-2",
          output: { status: "still_running", toolCallId: "call-2" },
        }),
      ]),
    ];
    const next = finalizeInterruptedTools(messages, "Run failed before this tool finished.");
    const parts = next[0]!.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    for (const part of parts) {
      expect(part.state).toBe("error");
      if (part.state === "error") {
        expect(part.error.message).toBe("Run failed before this tool finished.");
      }
    }
  });

  it("leaves a tool that is still waiting for approval untouched", () => {
    // A suspended approval also ends its stream, so the tool has no result yet.
    // Finalizing it would show "Stopped" next to the prompt asking for it.
    const messages: UIMessage[] = [
      assistant([tool("input-available")]),
    ];
    const next = finalizeInterruptedTools(messages, undefined, {
      keepPendingApprovalTools: new Set(["generate_image"]),
    });
    expect(next).toBe(messages);
  });
});

describe("settleStoppedRunTools", () => {
  it("keeps a pending approval card open while settling everything else", () => {
    const messages: UIMessage[] = [
      assistant([
        tool("input-available"),
        tool("input-available", {
          id: "part-2",
          toolCallId: "call-2",
          toolName: "web_search",
        }),
      ]),
    ];
    const next = settleStoppedRunTools(messages, { pendingApprovalToolNames: ["generate_image"] });
    const parts = next[0]!.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    // The approval-gated tool keeps its in-flight state...
    expect(parts[0]?.state).toBe("input-available");
    // ...while the unrelated unfinished tool is still finalized.
    expect(parts[1]?.state).toBe("error");
  });

  it("still settles a finished call of a tool that later waits for approval", () => {
    // The same tool can run twice in a turn; only the unfinished one is pending.
    const messages: UIMessage[] = [
      assistant([
        tool("output-available", {
          id: "part-1",
          toolCallId: "call-1",
          output: { images: ["url"] },
        }),
        tool("input-available", { id: "part-2", toolCallId: "call-2" }),
      ]),
    ];
    const next = settleStoppedRunTools(messages, { pendingApprovalToolNames: ["generate_image"] });
    const parts = next[0]!.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    expect(parts[0]?.state).toBe("output-available");
    expect(parts[1]?.state).toBe("input-available");
  });

  it("settles everything when no approval is pending", () => {
    const messages: UIMessage[] = [assistant([tool("input-available")])];
    const next = settleStoppedRunTools(messages, {});
    const part = next[0]!.parts[0];
    expect(part?.type === "tool" && part.state).toBe("error");
  });

  it("drops a card whose tool ran again in a later part", () => {
    // Answering an approval resumes the run, so the tool re-runs under a new id
    // and the original card can never settle on its own.
    const messages: UIMessage[] = [
      assistant([tool("input-available")]),
      assistant(
        [
          tool("output-available", {
            id: "part-2",
            toolCallId: "call-2",
            output: { results: ["done"] },
          }),
        ],
        "a2",
      ),
    ];
    const next = settleStoppedRunTools(messages, {});
    expect(next[0]!.parts).toHaveLength(0);
    expect(next[1]!.parts).toHaveLength(1);
  });

  it("keeps a card whose tool did not run again", () => {
    const messages: UIMessage[] = [assistant([tool("input-available")])];
    const next = settleStoppedRunTools(messages, {});
    const part = next[0]!.parts[0];
    expect(part?.type === "tool" && part.state).toBe("error");
  });
});

describe("stillOpenToolCards", () => {
  it("reports an unfinished card that no approval explains", () => {
    const messages: UIMessage[] = [assistant([tool("input-available")])];
    expect(stillOpenToolCards(messages)).toBe(true);
    expect(stillOpenToolCards(messages, ["generate_image"])).toBe(false);
  });

  it("reports nothing when every card settled", () => {
    const messages: UIMessage[] = [
      assistant([tool("output-available", { output: { ok: true } })]),
    ];
    expect(stillOpenToolCards(messages)).toBe(false);
  });
});
