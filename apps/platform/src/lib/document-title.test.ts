import { describe, expect, it } from "vitest";

import { formatWorkspaceTitle } from "./document-title";

describe("formatWorkspaceTitle", () => {
  it("suffixes the app name", () => {
    expect(formatWorkspaceTitle("New chat")).toBe("New chat – Anreal");
    expect(formatWorkspaceTitle("  Weekly report  ")).toBe(
      "Weekly report – Anreal",
    );
  });

  it("falls back to the app name", () => {
    expect(formatWorkspaceTitle(null)).toBe("Anreal");
    expect(formatWorkspaceTitle("   ")).toBe("Anreal");
  });
});
