import { describe, expect, it } from "vitest";
import { extractMarkdownTables } from "./markdown-tables.js";

describe("extractMarkdownTables", () => {
  it("extracts a GFM table", () => {
    const md = [
      "# Page",
      "| region | revenue |",
      "| --- | --- |",
      "| east | 100 |",
      "| west | 200 |",
    ].join("\n");
    const tables = extractMarkdownTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.columns).toEqual(["region", "revenue"]);
    expect(tables[0]!.rows).toEqual([
      ["east", "100"],
      ["west", "200"],
    ]);
  });

  it("skips malformed tables (no separator row)", () => {
    const md = "| a | b |\n| 1 | 2 |\n";
    expect(extractMarkdownTables(md)).toHaveLength(0);
  });

  it("extracts multiple tables in order", () => {
    const md = "| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |\n";
    expect(extractMarkdownTables(md)).toHaveLength(2);
  });
});