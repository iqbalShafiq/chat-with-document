import { describe, expect, it } from "vitest";
import { reduceToolWaitProgress } from "./tool-wait-progress.js";

const event = (overrides: Record<string, unknown>) => ({
  toolCallId: "call-1",
  toolName: "deep_research",
  phase: "wait_elapsed" as const,
  elapsedMs: 0,
  waitCount: 1,
  ...overrides,
});

describe("reduceToolWaitProgress", () => {
  it("keeps the newest elapsed while the same call is still waiting", () => {
    let state = reduceToolWaitProgress({}, event({ elapsedMs: 15_000, waitCount: 1 }));
    state = reduceToolWaitProgress(state, event({ elapsedMs: 48_000, waitCount: 2 }));
    expect(state["call-1"]?.elapsedMs).toBe(48_000);
  });

  it("does not let an awaiting slice reset the elapsed back to zero", () => {
    let state = reduceToolWaitProgress({}, event({ elapsedMs: 116_000, waitCount: 3 }));
    // The awaiting event starts a new slice and reports no elapsed of its own.
    state = reduceToolWaitProgress(
      state,
      event({ phase: "awaiting", elapsedMs: 0, waitCount: 0 }),
    );
    expect(state["call-1"]?.elapsedMs).toBe(116_000);
    expect(state["call-1"]?.phase).toBe("awaiting");
  });

  it("starts fresh when the same id begins a new call", () => {
    let state = reduceToolWaitProgress({}, event({ elapsedMs: 90_000 }));
    state = reduceToolWaitProgress(state, event({ phase: "running", elapsedMs: 0 }));
    expect(state["call-1"]?.elapsedMs).toBe(0);
  });
});