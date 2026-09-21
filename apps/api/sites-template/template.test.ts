import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;

describe("sites template", () => {
  it("contains every scaffold file", () => {
    for (const file of [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      "src/main.tsx",
      "src/App.tsx",
      "src/tokens.css",
      "src/vite-env.d.ts",
    ]) {
      expect(existsSync(join(DIR, file))).toBe(true);
    }
  });

  it("defines the required design tokens and forbids gradients", () => {
    const css = readFileSync(join(DIR, "src/tokens.css"), "utf8");
    for (const token of ["--font-display", "--font-body", "--color-ink", "--color-paper", "--color-accent", "--space-section"]) {
      expect(css).toContain(token);
    }
    expect(css).not.toContain("linear-gradient");
  });

  it("renders sections from a SECTIONS array with data-section anchors", () => {
    const app = readFileSync(join(DIR, "src/App.tsx"), "utf8");
    expect(app).toContain("SECTIONS");
    expect(app).toContain("data-section");
    expect(app).not.toContain("lorem ipsum");
  });
});
