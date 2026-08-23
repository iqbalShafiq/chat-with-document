import { describe, expect, it } from "vitest";
import { parseChartSpec, parseTableDto } from "#/lib/data-analysis";
import { formatToolOutput } from "./tool-io-format";

describe("formatToolOutput for tabular tools", () => {
  it("surfaces chart + table from analyze_dataset", () => {
    const section = formatToolOutput("analyze_dataset", {
      operation: "aggregate",
      summary: "2 groups",
      result: { columns: [{ name: "region", type: "string" }], rows: [["east"]], rowCount: 1, truncated: false },
      chart: { kind: "bar", labels: ["east"], series: [{ name: "revenue", values: [100] }] },
    });
    expect(section.title).toBe("Result");
    expect(section.chart).toBeDefined();
    expect(section.table).toBeDefined();
    expect(parseChartSpec(section.chart)).not.toBeNull();
    expect(parseTableDto(section.table)).not.toBeNull();
  });

  it("surfaces a table from read_dataset", () => {
    const section = formatToolOutput("read_dataset", {
      name: "sales",
      rowCount: 1,
      columns: [{ name: "region", type: "string" }],
      preview: [["east"]],
    });
    expect(section.summary).toContain("sales");
    expect(section.summary).toContain("1 rows");
    expect(parseTableDto(section.table)).not.toBeNull();
  });

  it("surfaces a table from query_dataset_sql", () => {
    const section = formatToolOutput("query_dataset_sql", {
      columns: [{ name: "region", type: "string" }],
      rows: [["east"]],
      rowCount: 1,
      truncated: false,
    });
    expect(section.summary).toBe("1 row");
    expect(parseTableDto(section.table)).not.toBeNull();
  });

  it("summarizes extracted tables from extract_document_tables", () => {
    const section = formatToolOutput("extract_document_tables", {
      tables: [
        {
          filename: "report.pdf",
          pageIndex: 0,
          tableIndex: 1,
          columns: [{ name: "region", type: "string" }],
          rowCount: 42,
        },
      ],
    });
    expect(section.summary).toBe("1 table found");
    expect(section.items?.[0].title).toContain("report.pdf");
    expect(section.items?.[0].meta).toContain("42 rows");
  });
});