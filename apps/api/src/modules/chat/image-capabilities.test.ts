import { describe, expect, it } from "vitest";
import { parseImageCapabilities } from "./image-capabilities.js";

describe("parseImageCapabilities", () => {
  it("defaults to nMax 4 when the raw value is null", () => {
    expect(parseImageCapabilities(null)).toEqual({ nMax: 4 });
  });

  it("defaults to nMax 4 for non-object values", () => {
    expect(parseImageCapabilities("nope")).toEqual({ nMax: 4 });
    expect(parseImageCapabilities([{ n: { max: 8 } }])).toEqual({ nMax: 4 });
  });

  it("defaults to nMax 4 when n is missing or malformed", () => {
    expect(parseImageCapabilities({})).toEqual({ nMax: 4 });
    expect(parseImageCapabilities({ n: "5" })).toEqual({ nMax: 4 });
    expect(parseImageCapabilities({ n: { min: 1 } })).toEqual({ nMax: 4 });
  });

  it("reads nMax from n.max", () => {
    expect(parseImageCapabilities({ n: { min: 1, max: 8 } })).toEqual({
      nMax: 8,
    });
  });

  it("floors fractional n.max and clamps at 1", () => {
    expect(parseImageCapabilities({ n: { max: 2.7 } })).toEqual({ nMax: 2 });
    expect(parseImageCapabilities({ n: { max: 0 } })).toEqual({ nMax: 1 });
  });

  it("keeps string arrays for background, aspectRatios, quality", () => {
    const parsed = parseImageCapabilities({
      n: { max: 4 },
      background: ["transparent"],
      aspectRatios: ["1:1", "16:9"],
      quality: ["low", "high"],
    });
    expect(parsed).toEqual({
      nMax: 4,
      background: ["transparent"],
      aspectRatios: ["1:1", "16:9"],
      quality: ["low", "high"],
    });
  });

  it("filters non-strings out of capability arrays", () => {
    const parsed = parseImageCapabilities({
      aspectRatios: ["1:1", 42, null, "16:9"],
    });
    expect(parsed).toEqual({ nMax: 4, aspectRatios: ["1:1", "16:9"] });
  });

  it("omits empty capability arrays", () => {
    const parsed = parseImageCapabilities({ background: [], quality: "high" });
    expect(parsed).toEqual({ nMax: 4 });
  });
});
