import { describe, expect, it } from "vitest";
import { artifactWhere } from "./scope.js";

describe("artifactWhere", () => {
  it("standalone only matches NULL project", () => {
    expect(artifactWhere("u1", null)).toEqual({ userId: "u1", projectId: null });
  });
  it("project session only matches that project", () => {
    expect(artifactWhere("u1", "pX")).toEqual({ userId: "u1", projectId: "pX" });
  });
});
