import { describe, expect, it } from "vitest";
import { parseImageCapabilities } from "./image-capabilities.js";

describe("parseImageCapabilities", () => {
  it("fails closed when the raw value is null", () => {
    expect(() => parseImageCapabilities(null)).toThrow(
      "image capability catalog is invalid",
    );
  });

  it("fails closed for non-object values", () => {
    expect(() => parseImageCapabilities("nope")).toThrow(
      "image capability catalog is invalid",
    );
    expect(() => parseImageCapabilities([{ n: { max: 8 } }])).toThrow(
      "image capability catalog is invalid",
    );
  });

  it("fails closed when n is missing or malformed", () => {
    expect(() => parseImageCapabilities({})).toThrow(
      "image capability catalog is invalid",
    );
    expect(() => parseImageCapabilities({ n: "5" })).toThrow(
      "image capability catalog is invalid",
    );
    expect(() => parseImageCapabilities({ n: { min: 1 } })).toThrow(
      "image capability catalog is invalid",
    );
  });

  it("reads nMax from n.max", () => {
    expect(
      parseImageCapabilities({
        n: { min: 1, max: 8 },
        aspectRatios: ["1:1"],
        sizes: ["1024x1024"],
      }),
    ).toEqual({
      nMax: 8,
      aspectRatios: ["1:1"],
      sizes: ["1024x1024"],
    });
  });

  it("floors fractional n.max and clamps at 1", () => {
    expect(() =>
      parseImageCapabilities({
        n: { min: 1, max: 2.7 },
        aspectRatios: ["1:1"],
        sizes: ["1024x1024"],
      }),
    ).toThrow("image capability catalog is invalid");
    expect(() =>
      parseImageCapabilities({
        n: { min: 1, max: 0 },
        aspectRatios: ["1:1"],
        sizes: ["1024x1024"],
      }),
    ).toThrow("image capability catalog is invalid");
  });

  it("keeps string arrays for background, aspectRatios, quality", () => {
    const parsed = parseImageCapabilities({
      n: { min: 1, max: 4 },
      background: ["transparent"],
      aspectRatios: ["1:1", "16:9"],
      quality: ["low", "high"],
      sizes: ["1024x1024"],
    });
    expect(parsed).toEqual({
      nMax: 4,
      background: ["transparent"],
      aspectRatios: ["1:1", "16:9"],
      quality: ["low", "high"],
      sizes: ["1024x1024"],
    });
  });

  it("fails closed when capability arrays contain non-strings", () => {
    expect(() =>
      parseImageCapabilities({
        n: { min: 1, max: 4 },
        aspectRatios: ["1:1", 42, null, "16:9"],
        sizes: ["1024x1024"],
      }),
    ).toThrow("image capability catalog is invalid");
  });

  it("fails closed when capability arrays are empty or absent", () => {
    expect(() =>
      parseImageCapabilities({
        n: { min: 1, max: 4 },
        background: [],
        quality: "high",
      }),
    ).toThrow("image capability catalog is invalid");
  });

  it("fails closed for unknown catalog fields", () => {
    expect(() =>
      parseImageCapabilities({
        n: { min: 1, max: 4 },
        aspectRatios: ["1:1"],
        sizes: ["1024x1024"],
        unknown: true,
      }),
    ).toThrow("image capability catalog is invalid");
  });
});
