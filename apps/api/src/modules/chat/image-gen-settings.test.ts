import { describe, expect, it } from "vitest";
import {
  imageGenSettingsSchema,
  parseImageGenSettings,
} from "./image-gen-settings.js";

describe("imageGenSettingsSchema", () => {
  it("accepts a full valid settings object", () => {
    const parsed = imageGenSettingsSchema.safeParse({
      modelId: "openai/gpt-5-image-mini",
      aspectRatio: "16:9",
      quality: "high",
      background: "transparent",
      n: 2,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      modelId: "openai/gpt-5-image-mini",
      aspectRatio: "16:9",
      quality: "high",
      background: "transparent",
      n: 2,
    });
  });

  it("accepts an empty object (all fields optional)", () => {
    const parsed = imageGenSettingsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({});
  });

  it("accepts a subset of fields", () => {
    const parsed = imageGenSettingsSchema.safeParse({ n: 4 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ n: 4 });
  });

  it("rejects n below 1", () => {
    expect(imageGenSettingsSchema.safeParse({ n: 0 }).success).toBe(false);
  });

  it("rejects n above 10", () => {
    expect(imageGenSettingsSchema.safeParse({ n: 11 }).success).toBe(false);
  });

  it("rejects non-integer n", () => {
    expect(imageGenSettingsSchema.safeParse({ n: 2.5 }).success).toBe(false);
  });

  it("rejects string n (no coercion)", () => {
    expect(imageGenSettingsSchema.safeParse({ n: "3" }).success).toBe(false);
  });

  it("rejects non-string string fields", () => {
    expect(imageGenSettingsSchema.safeParse({ modelId: 42 }).success).toBe(
      false,
    );
  });

  it("rejects empty string fields", () => {
    expect(imageGenSettingsSchema.safeParse({ quality: "" }).success).toBe(
      false,
    );
  });
});

describe("parseImageGenSettings", () => {
  it("returns the parsed settings for a valid object", () => {
    expect(parseImageGenSettings({ n: 3, aspectRatio: "1:1" })).toEqual({
      n: 3,
      aspectRatio: "1:1",
    });
  });

  it("returns null for a non-object value", () => {
    expect(parseImageGenSettings(null)).toBeNull();
    expect(parseImageGenSettings(undefined)).toBeNull();
    expect(parseImageGenSettings("nope")).toBeNull();
    expect(parseImageGenSettings([{ n: 2 }])).toBeNull();
  });

  it("returns null for an invalid object", () => {
    expect(parseImageGenSettings({ n: 99 })).toBeNull();
  });

  it("returns an empty settings object for an empty object", () => {
    expect(parseImageGenSettings({})).toEqual({});
  });
});
