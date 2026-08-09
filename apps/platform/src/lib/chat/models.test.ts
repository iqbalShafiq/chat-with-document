import { describe, expect, it } from "vitest";
import {
  formatModelContext,
  formatModelPrice,
  modalityLabel,
} from "./models";

describe("formatModelPrice", () => {
  it("formats per-million token prices", () => {
    expect(formatModelPrice(0.2)).toBe("$0.20 / 1M");
    expect(formatModelPrice(0.09)).toBe("$0.09 / 1M");
  });

  it("returns Free for zero and null for missing", () => {
    expect(formatModelPrice(0)).toBe("Free");
    expect(formatModelPrice(null)).toBeNull();
  });
});

describe("formatModelContext", () => {
  it("formats token counts with K/M suffixes", () => {
    expect(formatModelContext(1_050_000)).toBe("1.1M tokens");
    expect(formatModelContext(400_000)).toBe("400K tokens");
    expect(formatModelContext(1_000)).toBe("1K tokens");
    expect(formatModelContext(512)).toBe("512 tokens");
  });
});

describe("modalityLabel", () => {
  it("maps known modalities to short tags and uppercases others", () => {
    expect(modalityLabel("text")).toBe("TEXT");
    expect(modalityLabel("image")).toBe("IMAGE");
    expect(modalityLabel("file")).toBe("FILE");
    expect(modalityLabel("audio")).toBe("AUDIO");
    expect(modalityLabel("video")).toBe("VIDEO");
    expect(modalityLabel("code")).toBe("CODE");
  });
});
