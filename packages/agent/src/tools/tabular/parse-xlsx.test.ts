import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parseXlsx } from "./parse-xlsx.js";

describe("parseXlsx", () => {
  it("parses all sheets with typed cells", async () => {
    const buffer = await readFile(new URL("./fixtures/multi-sheet.xlsx", import.meta.url));
    const sheets = await parseXlsx(new Uint8Array(buffer));
    expect(sheets.length).toBeGreaterThanOrEqual(1);
    const first = sheets[0]!;
    expect(first.columns.length).toBeGreaterThan(0);
    expect(first.rows.length).toBeGreaterThan(0);
    const numeric = first.columns.findIndex((c) => c.type === "number");
    if (numeric >= 0) expect(typeof first.rows[0]![numeric]).toBe("number");
  });
});