import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_SLICE_MS,
  DEEP_RESEARCH_WAIT_SLICE_MS,
  IMAGE_WAIT_SLICE_MS,
  waitBudgetForTool,
} from "./limits.js";

describe("waitBudgetForTool", () => {
  it("uses a longer slice for image generation and deep research", () => {
    expect(waitBudgetForTool("generate_image")).toBe(IMAGE_WAIT_SLICE_MS);
    expect(waitBudgetForTool("edit_image")).toBe(IMAGE_WAIT_SLICE_MS);
    expect(waitBudgetForTool("deep_research")).toBe(DEEP_RESEARCH_WAIT_SLICE_MS);
    expect(waitBudgetForTool("query_dataset_sql")).toBe(DEFAULT_WAIT_SLICE_MS);
  });

  it("refuses to budget control tools", () => {
    expect(() => waitBudgetForTool("await_tool_call")).toThrow(/must not be wrapped/);
    expect(() => waitBudgetForTool("cancel_tool_call")).toThrow(/must not be wrapped/);
  });
});
