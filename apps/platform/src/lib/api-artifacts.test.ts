import { describe, expect, it } from "vitest";
import {
  formatPinnedArtifactRef,
  mergePinnedEntitiesText,
  parsePinnedArtifactRefs,
  stripPinnedArtifactRefs,
} from "./api-artifacts";

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

describe("stripPinnedArtifactRefs", () => {
  it("removes token spans and collapses leftover whitespace", () => {
    expect(stripPinnedArtifactRefs("Lanjutkan site ini [@site Kedai (abc)]")).toBe(
      "Lanjutkan site ini",
    );
    expect(stripPinnedArtifactRefs("[@site A (1)]\n\nHalo\n[@document B (2)]  ")).toBe(
      "Halo",
    );
    expect(stripPinnedArtifactRefs("teks biasa")).toBe("teks biasa");
  });
});

describe("mergePinnedEntitiesText", () => {
  it("appends missing tokens on their own lines", () => {
    expect(mergePinnedEntitiesText("halo", ["[@site A (1)]"])).toBe("halo\n[@site A (1)]");
    expect(mergePinnedEntitiesText("", ["[@site A (1)]", "[@document B (2)]"])).toBe(
      "[@site A (1)]\n[@document B (2)]",
    );
  });

  it("never duplicates tokens already present (queue then send)", () => {
    const token = "[@site A (1)]";
    expect(mergePinnedEntitiesText(`halo\n${token}`, [token])).toBe(`halo\n${token}`);
  });

  it("returns input untouched when there is nothing to merge", () => {
    expect(mergePinnedEntitiesText("halo", [])).toBe("halo");
    expect(mergePinnedEntitiesText("halo", ["  "])).toBe("halo");
  });
});
