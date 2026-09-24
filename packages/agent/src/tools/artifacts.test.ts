import { describe, expect, it } from "vitest";
import { ARTIFACT_TOOL_DEFINITIONS, createArtifactTools, decodeArtifactChoice, encodeArtifactChoice } from "./artifacts.js";

describe("ARTIFACT_TOOL_DEFINITIONS", () => {
  it("exposes list_artifacts, find_images, list_sessions", () => {
    expect(ARTIFACT_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["find_images", "list_artifacts", "list_sessions"].sort(),
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
});

describe("createArtifactTools", () => {
  it("find_images returns scoped images and focuses the first", async () => {
    const focused: string[] = [];
    const tools = createArtifactTools({
      list: async () => ({ items: [{ id: "img-1", caption: "hero logo" }] }),
      get: async () => null,
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
