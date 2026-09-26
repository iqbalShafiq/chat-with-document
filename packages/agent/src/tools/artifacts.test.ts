import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TOOL_DEFINITIONS,
  PINNED_ARTIFACT_INSTRUCTION,
  createArtifactTools,
  decodeArtifactChoice,
  encodeArtifactChoice,
  formatPinnedArtifactRef,
} from "./artifacts.js";

describe("ARTIFACT_TOOL_DEFINITIONS", () => {
  it("exposes list, find, sessions, get, and excerpt tools", () => {
    expect(ARTIFACT_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["find_images", "get_artifact", "get_session_excerpt", "list_artifacts", "list_sessions"].sort(),
    );
  });
});

describe("artifact choice convention", () => {
  it("round-trips type and id", () => {
    expect(decodeArtifactChoice(encodeArtifactChoice("image", "img-1"))).toEqual({
      type: "image",
      id: "img-1",
    });
    expect(decodeArtifactChoice("plain text")).toBeNull();
  });

  it("formats pinned references the instruction describes", () => {
    expect(formatPinnedArtifactRef("site", "abc123", "Kedai Kopi")).toBe(
      "[@site Kedai Kopi (abc123)]",
    );
    expect(formatPinnedArtifactRef("site", "abc123", "a[b]c")).toBe("[@site abc (abc123)]");
    expect(PINNED_ARTIFACT_INSTRUCTION).toContain("[@site Kedai Kopi (abc123)]");
    expect(PINNED_ARTIFACT_INSTRUCTION).toContain("view_site_page");
  });
});

describe("createArtifactTools", () => {
  it("find_images returns scoped images and focuses the first", async () => {
    const focused: string[] = [];
    const tools = createArtifactTools({
      list: async () => ({ items: [{ id: "img-1", caption: "hero logo" }] }),
      get: async () => null,
      getExcerpt: async () => null,
      onFocus: (f) => {
        focused.push(f.artifactId);
      },
    });
    const findImages = tools[1]!;
    const out = (await findImages.call({ query: "logo", limit: 5 })) as unknown;
    const images = (out as { images: unknown[] }).images;
    expect(images).toHaveLength(1);
    expect(focused).toEqual(["img-1"]);
  });
});
