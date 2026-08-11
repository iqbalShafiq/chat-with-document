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
});
