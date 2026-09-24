import { describe, expect, it } from "vitest";
import { WORKSPACE_TOOL_DEFINITIONS } from "./workspace-tools.js";

describe("WORKSPACE_TOOL_DEFINITIONS", () => {
  it("exposes manage_tasks and manage_schedules", () => {
    expect(WORKSPACE_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["manage_schedules", "manage_tasks"].sort(),
    );
  });
});
