import { describe, expect, it } from "vitest";
import { normalizeSessionTitle } from "./chat-session.js";

describe("normalizeSessionTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSessionTitle("  Hello   world \n ")).toBe("Hello world");
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeSessionTitle("")).toBeNull();
    expect(normalizeSessionTitle("   ")).toBeNull();
  });

  it("caps length at 48 chars (TITLE_MAX parity)", () => {
    const long = "a".repeat(100);
    expect(normalizeSessionTitle(long)).toHaveLength(48);
  });

  it("preserves exactly 48 chars without truncation", () => {
    expect(normalizeSessionTitle("a".repeat(48))).toBe("a".repeat(48));
  });

  it("truncates 49 chars to 48", () => {
    expect(normalizeSessionTitle("a".repeat(49))).toHaveLength(48);
  });

  it("caps by code point: emoji title has no lone surrogates", () => {
    const chars = Array.from(normalizeSessionTitle("😀".repeat(60))!);
    expect(chars).toHaveLength(48);
    expect(chars.every((c) => c === "😀")).toBe(true);
  });
});
