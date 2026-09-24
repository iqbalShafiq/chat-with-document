import { describe, expect, it } from "vitest";
import { formatPinnedArtifactRef, parsePinnedArtifactRefs } from "./api-artifacts";

describe("formatPinnedArtifactRef", () => {
  it("matches the agent-side formatter vectors", () => {
    expect(formatPinnedArtifactRef("site", "abc123", "Kedai Kopi")).toBe(
      "[@site Kedai Kopi (abc123)]",
    );
    expect(formatPinnedArtifactRef("site", "abc123", "a[b]c")).toBe("[@site abc (abc123)]");
    expect(formatPinnedArtifactRef("document", "d1", "  ")).toBe("[@document document (d1)]");
  });
});

describe("parsePinnedArtifactRefs", () => {
  it("finds pinned refs with positions for chip rendering and removal", () => {
    const text = "Lanjutkan site ini [@site Kedai Kopi (abc123)] ya";
    const refs = parsePinnedArtifactRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: "site", id: "abc123", label: "Kedai Kopi" });
    expect(text.slice(refs[0]!.start, refs[0]!.end)).toBe("[@site Kedai Kopi (abc123)]");
  });

  it("ignores bracket noise that is not a pinned ref", () => {
    expect(parsePinnedArtifactRefs("lihat [bagian 2] dan (catatan)")).toEqual([]);
  });
});
