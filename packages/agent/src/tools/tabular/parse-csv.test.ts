import { describe, expect, it } from "vitest";
import { parseCsv, sheetFromRows, detectHeader, inferColumnTypes } from "./parse-csv.js";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("handles quoted fields with commas and newlines", () => {
    expect(parseCsv('a,b\n"x, y","line1\nline2"\n')).toEqual([
      ["a", "b"],
      ["x, y", "line1\nline2"],
    ]);
  });
  it("handles escaped quotes", () => {
    expect(parseCsv('a\n"say ""hi"""\n')).toEqual([["a"], ['say "hi"']]);
  });
  it("strips a UTF-8 BOM", () => {
    expect(parseCsv("\uFEFFa,b\n1,2\n")[0]).toEqual(["a", "b"]);
  });
  it("normalizes CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("detectHeader", () => {
  it("treats the first row as header", () => {
    const { header, dataRows } = detectHeader([
      ["region", "revenue"],
      ["east", "100"],
    ]);
    expect(header).toEqual(["region", "revenue"]);
    expect(dataRows).toEqual([["east", "100"]]);
  });
});

describe("inferColumnTypes + sheetFromRows", () => {
  it("infers numbers, strings and nulls", () => {
    const { header, dataRows } = detectHeader([
      ["n", "s", "empty"],
      ["1", "a", ""],
      ["2.5", "b", "x"],
    ]);
    expect(inferColumnTypes(dataRows)).toEqual(["number", "string", "string"]);
    const sheet = sheetFromRows("Sheet1", [["n", "s"], ["1", "a"], ["", "b"]]);
    expect(sheet.columns).toEqual([
      { name: "n", type: "number" },
      { name: "s", type: "string" },
    ]);
    expect(sheet.rows).toEqual([
      [1, "a"],
      [null, "b"],
    ]);
  });
});
