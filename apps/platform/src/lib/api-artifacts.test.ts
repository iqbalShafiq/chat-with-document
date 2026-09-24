import { describe, expect, it } from "vitest";
import { formatPinnedArtifactRef } from "./api-artifacts";

describe("formatPinnedArtifactRef", () => {
  it("matches the agent-side formatter vectors", () => {
    expect(formatPinnedArtifactRef("site", "abc123", "Kedai Kopi")).toBe(
      "[@site Kedai Kopi (abc123)]",
    );
    expect(formatPinnedArtifactRef("site", "abc123", "a[b]c")).toBe("[@site abc (abc123)]");
    expect(formatPinnedArtifactRef("document", "d1", "  ")).toBe("[@document document (d1)]");
  });
});
