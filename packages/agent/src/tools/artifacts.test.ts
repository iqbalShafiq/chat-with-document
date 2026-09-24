import { describe, expect, it } from "vitest";
import { ARTIFACT_TOOL_DEFINITIONS } from "./artifacts.js";

describe("ARTIFACT_TOOL_DEFINITIONS", () => {
  it("exposes list_artifacts, find_images, list_sessions", () => {
    expect(ARTIFACT_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["find_images", "list_artifacts", "list_sessions"].sort(),
    );
  });
});
