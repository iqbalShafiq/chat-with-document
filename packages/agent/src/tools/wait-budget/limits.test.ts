import { describe, expect, it } from "vitest";
import {
  BASE_WAIT_SLICE_MS,
  escalateWaitSlice,
  MAX_WAIT_SLICE_MS,
  waitBudgetForTool,
} from "./limits.js";

describe("waitBudgetForTool", () => {
  it("uses one uniform base slice for every tool", () => {
    const override = process.env.TOOL_WAIT_SLICE_MS
      ? Number(process.env.TOOL_WAIT_SLICE_MS)
      : undefined;
    // No per-name tuning: an unknown tool and a known slow tool start alike.
    expect(waitBudgetForTool("query_dataset_sql")).toBe(override ?? BASE_WAIT_SLICE_MS);
    expect(waitBudgetForTool("deep_research")).toBe(override ?? BASE_WAIT_SLICE_MS);
    expect(waitBudgetForTool("generate_image")).toBe(override ?? BASE_WAIT_SLICE_MS);
    expect(waitBudgetForTool("some_future_tool")).toBe(override ?? BASE_WAIT_SLICE_MS);
  });

  it("refuses to budget control tools", () => {
    expect(() => waitBudgetForTool("await_tool_call")).toThrow(/must not be wrapped/);
    expect(() => waitBudgetForTool("cancel_tool_call")).toThrow(/must not be wrapped/);
  });
});

describe("escalateWaitSlice", () => {
  it("uses the base slice before any wait has elapsed", () => {
    expect(escalateWaitSlice(1_000, 0)).toBe(1_000);
  });

  it("doubles the slice with every elapsed wait", () => {
    expect(escalateWaitSlice(1_000, 1)).toBe(2_000);
    expect(escalateWaitSlice(1_000, 2)).toBe(4_000);
    expect(escalateWaitSlice(1_000, 3)).toBe(8_000);
  });

  it("never returns less than the base and clamps growth at the ceiling", () => {
    expect(escalateWaitSlice(1_000, 1)).toBeGreaterThanOrEqual(1_000);
    expect(escalateWaitSlice(1_000, 40)).toBe(MAX_WAIT_SLICE_MS);
    // Growth is monotonic, so a long job keeps getting fewer, longer waits.
    expect(escalateWaitSlice(1_000, 6)).toBeGreaterThan(escalateWaitSlice(1_000, 3));
  });

  it("ignores a non-positive or non-finite wait count", () => {
    expect(escalateWaitSlice(500, -3)).toBe(500);
    expect(escalateWaitSlice(500, Number.NaN)).toBe(500);
  });
});