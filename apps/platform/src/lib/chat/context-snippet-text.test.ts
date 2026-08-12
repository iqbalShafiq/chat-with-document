import { describe, expect, it } from "vitest";
import {
  MAX_CONTEXT_SNIPPET_CHARS,
  normalizeContextText,
} from "./context-snippet-text";

describe("normalizeContextText", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeContextText("  a   b\n\n c  ", "user")).toBe("a b c");
  });

  it("strips citation markers from assistant text", () => {
    expect(
      normalizeContextText("Answer [[cite:1]] here.", "assistant"),
    ).toBe("Answer here.");
  });

  it("keeps user text untouched apart from whitespace", () => {
    expect(normalizeContextText("[[cite:1]] stays", "user")).toBe(
      "[[cite:1]] stays",
    );
  });

  it("truncates to 2000 chars", () => {
    const text = "x".repeat(2500);
    const normalized = normalizeContextText(text, "user");
    expect(normalized).toBe("x".repeat(MAX_CONTEXT_SNIPPET_CHARS));
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(normalizeContextText("", "user")).toBeNull();
    expect(normalizeContextText("   \n  ", "assistant")).toBeNull();
  });
});
