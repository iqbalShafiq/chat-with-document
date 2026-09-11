import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_SLICE_MS,
  DEEP_RESEARCH_WAIT_SLICE_MS,
  IMAGE_WAIT_SLICE_MS,
  waitBudgetForTool,
} from "./limits.js";

describe("waitBudgetForTool", () => {
  it("uses a longer slice for image generation and deep research", () => {
    const override = process.env.TOOL_WAIT_SLICE_MS
      ? Number(process.env.TOOL_WAIT_SLICE_MS)
      : undefined;
    expect(waitBudgetForTool("generate_image")).toBe(override ?? IMAGE_WAIT_SLICE_MS);
    expect(waitBudgetForTool("edit_image")).toBe(override ?? IMAGE_WAIT_SLICE_MS);
    expect(waitBudgetForTool("deep_research")).toBe(override ?? DEEP_RESEARCH_WAIT_SLICE_MS);
    expect(waitBudgetForTool("query_dataset_sql")).toBe(override ?? DEFAULT_WAIT_SLICE_MS);
  });

  it("refuses to budget control tools", () => {
    expect(() => waitBudgetForTool("await_tool_call")).toThrow(/must not be wrapped/);
    expect(() => waitBudgetForTool("cancel_tool_call")).toThrow(/must not be wrapped/);
  });
});
