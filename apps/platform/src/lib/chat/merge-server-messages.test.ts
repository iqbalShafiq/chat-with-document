import { describe, expect, it } from "vitest";
import { parseUIMessage, type UIMessage, type UIMessagePart } from "@anvia/client";
import { mergeServerMessages } from "./merge-server-messages.js";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

function toolPart(input: {
  id: string;
  toolName: string;
  toolCallId: string;
  state: ToolPart["state"];
  output?: unknown;
  toolInput?: unknown;
}): ToolPart {
  const raw = {
    id: input.id,
    type: "tool",
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    input: input.toolInput ?? {},
    ...(input.state === "output-available" ? { output: input.output ?? null } : {}),
    state: input.state,
  };
  const parsed = parseUIMessage({ id: "m-1", role: "assistant", parts: [raw] });
  const part = parsed.parts[0];
  if (!part || part.type !== "tool") throw new Error("expected a tool part");
  return part;
}

function assistant(parts: UIMessagePart[], id = "a1"): UIMessage {
  return { id, role: "assistant", parts };
}

const stillRunning = (jobId: string) => ({ status: "still_running", toolCallId: jobId });

describe("mergeServerMessages", () => {
  it("keeps a live checkpoint instead of the server's missing result", () => {
    // Server memory only commits settled tool output, so the snapshot describes
    // this still-running call as an unfinished tool-call with no result.
    const server: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "input-available",
        }),
      ]),
    ];
    const live: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "output-available",
          output: stillRunning("job-1"),
        }),
      ]),
    ];

    const merged = mergeServerMessages(server, live);
    const part = merged[0]!.parts[0];
    expect(part?.type === "tool" && part.state).toBe("output-available");
  });

  it("takes the server result once the call has actually settled", () => {
    const server: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "output-available",
          output: { results: ["final"] },
        }),
      ]),
    ];
    const live: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "output-available",
          output: stillRunning("job-1"),
        }),
      ]),
    ];

    const merged = mergeServerMessages(server, live);
    const part = merged[0]!.parts[0];
    if (part?.type !== "tool" || part.state !== "output-available") {
      throw new Error("expected a settled tool part");
    }
    expect(part.output).toEqual({ results: ["final"] });
  });

  it("leaves the server snapshot untouched when nothing is live", () => {
    const server: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "output-available",
          output: { results: ["done"] },
        }),
      ]),
    ];
    expect(mergeServerMessages(server, [])).toBe(server);
  });

  it("does not let a locally settled result be replaced", () => {
    const server: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "input-available",
        }),
      ]),
    ];
    const live: UIMessage[] = [
      assistant([
        toolPart({
          id: "p-1",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "output-available",
          output: { results: ["local"] },
        }),
      ]),
    ];

    const merged = mergeServerMessages(server, live);
    const part = merged[0]!.parts[0];
    if (part?.type !== "tool" || part.state !== "output-available") {
      throw new Error("expected a settled tool part");
    }
    expect(part.output).toEqual({ results: ["local"] });
  });
});