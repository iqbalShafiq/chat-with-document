# Tabular Data Analysis (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload CSV/XLSX documents (and extract tables from existing PDF/image docs), then analyze them in chat via deterministic operations and read-only DuckDB SQL, with tables and SVG charts rendered inside the tool-result card mid-chat.

**Architecture:** CSV/XLSX are `Document` rows (reuse ownership/session-linking/quota). The ingest worker gets a tabular parse branch that stores structured sheets on `Document.tabularData` plus a synthetic markdown `DocumentPage`. A new `tabular/` module in `packages/agent` provides pure parsers + analysis ops + a DuckDB SELECT-only runner. Four new tools (`read_dataset`, `analyze_dataset`, `query_dataset_sql`, `extract_document_tables`) are registered on the main agent and stream structured output whose `chart`/table payload is rendered by new `DataChart`/`DataTable` components in `ToolActivityPanel`.

**Tech Stack:** Node 22, pnpm 10, TypeScript, Prisma 7 (Postgres), Anvia v0.26 (`@anvia/core`, `createTool`), `read-excel-file` (xlsx), `duckdb` (in-process SQL), Zod 4, Vitest, React 19, Tailwind v4.

## Global Constraints

- Stay on the Anvia **v0** train (`@anvia/core@0.26.x`). Do not upgrade to v1.
- `ToolResultContent` is text/image only; `UIStreamEvent` supports only 6 types — **charts/tables ride in `part.output` (JSON)**, never new stream types.
- Keep provider credentials and providers server-side. Tools are created via `createTool` with dependency injection (prisma/r2/runner passed in), mirroring `packages/agent/src/tools/documents.ts`.
- Platform must **not** import `@assingment/agent` server code; it mirrors DTO types in `apps/platform/src/lib/data-analysis.ts`.
- No code execution (no Python). SQL is **read-only**: only `SELECT` / `WITH … SELECT`, no DDL/DML, row cap + timeout enforced.
- Caps: `MAX_TABULAR_ROWS = 50_000`, `MAX_TABULAR_COLUMNS = 100`, SQL result cap `500`, SQL timeout `10s`.
- Document upload MIME allowlist lives in `apps/api/src/modules/documents/service.ts`; client `accept` in `apps/platform/src/components/composer/composer-attach-control.tsx`.
- Every task ends green (`pnpm --filter agent test` / `pnpm --filter api test` / `pnpm --filter platform test`) and a commit.
- Design doc: `docs/superpowers/specs/2026-08-21-data-analysis-deep-research-design.md`.

## File Structure

```
packages/agent/src/tools/tabular/
  types.ts              # CellValue, ColumnType, TabularColumn, TabularSheet, DatasetRef
  chart-spec.ts         # ChartSpec union
  parse-csv.ts          # RFC 4180 CSV -> sheets + type inference
  parse-xlsx.ts         # read-excel-file -> sheets
  markdown-tables.ts    # GFM markdown tables in page markdown -> sheets
  tabular-analysis.ts   # pure ops (profile/aggregate/filter/sort/top_n/correlation/trend)
  sql.ts                # read-only DuckDB runner + guard
  tools.ts              # createTabularAnalysisTools (read_dataset, analyze_dataset,
                        #   query_dataset_sql, extract_document_tables) + DatasetResolver iface
packages/agent/src/tools/tabular/*.test.ts
packages/agent/src/index.ts                  # export new modules
apps/api/prisma/schema.prisma                # Document.tabularData Json?
apps/api/src/modules/documents/service.ts    # allowlist + caps
apps/api/src/worker.ts                       # tabular ingest branch
apps/api/src/modules/chat/build-run-input.ts # wire tools + resolver
apps/platform/src/lib/data-analysis.ts       # DTO + parseChartSpec/parseTableDto validators
apps/platform/src/components/data/data-table.tsx
apps/platform/src/components/data/data-chart.tsx
apps/platform/src/components/data/*.test.tsx
apps/platform/src/components/tool-io-format.ts       # formatters + FormattedSection.chart/table
apps/platform/src/components/tool-activity-panel.tsx # render chart/table
apps/platform/src/components/composer/composer-attach-control.tsx
apps/platform/src/lib/documents/upload-file.ts
apps/platform/src/components/composer/features-popover.tsx # "Data analysis" switch (presentational)
apps/platform/src/routes/index.tsx             # dataAnalysisEnabled state + body
apps/platform/e2e/fixtures/{sales.csv,multi-sheet.xlsx,table-rich.pdf}
apps/platform/e2e/data-analysis.real-llm.e2e.ts
```

---

### Task 1: Tabular types + RFC 4180 CSV parser

**Files:**
- Create: `packages/agent/src/tools/tabular/types.ts`
- Create: `packages/agent/src/tools/tabular/parse-csv.ts`
- Test: `packages/agent/src/tools/tabular/parse-csv.test.ts`

**Interfaces:**
- Produces:
  - `type CellValue = number | string | boolean | null`
  - `type ColumnType = "number" | "string" | "boolean" | "null"`
  - `type TabularColumn = { name: string; type: ColumnType }`
  - `type TabularSheet = { name: string; columns: TabularColumn[]; rows: CellValue[][] }`
  - `type DatasetRef = { type: "upload"; documentId: string; sheet?: string } | { type: "document_table"; documentId: string; pageIndex: number; tableIndex: number }`
  - `parseCsv(text: string): string[][]` — full grid, RFC 4180 (quoted fields, escaped quotes, embedded commas/newlines, CRLF, BOM strip)
  - `detectHeader(rows: string[][]): { header: string[]; dataRows: string[][] }`
  - `inferColumnTypes(rows: string[][]): ColumnType[]`
  - `coerceRow(row: string[], types: ColumnType[]): CellValue[]`
  - `sheetFromRows(name: string, rawRows: string[][]): TabularSheet`

- [ ] **Step 1: Write the failing tests**

`packages/agent/src/tools/tabular/parse-csv.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter agent test -- tabular/parse-csv`
Expected: FAIL — module not found (`tabular/parse-csv` missing).

- [ ] **Step 3: Implement**

`packages/agent/src/tools/tabular/types.ts`:

```ts
export type CellValue = number | string | boolean | null;
export type ColumnType = "number" | "string" | "boolean" | "null";
export type TabularColumn = { name: string; type: ColumnType };
export type TabularSheet = {
  name: string;
  columns: TabularColumn[];
  rows: CellValue[][];
};
export type DatasetRef =
  | { type: "upload"; documentId: string; sheet?: string }
  | {
      type: "document_table";
      documentId: string;
      pageIndex: number;
      tableIndex: number;
    };
```

`packages/agent/src/tools/tabular/parse-csv.ts`:

```ts
import type { CellValue, ColumnType, TabularSheet } from "./types.js";

export function parseCsv(text: string): string[][] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

export function detectHeader(rows: string[][]): {
  header: string[];
  dataRows: string[][];
} {
  const header = rows[0] ?? [];
  return { header, dataRows: rows.slice(1) };
}

function toCell(value: string, type: ColumnType): CellValue {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (type === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") {
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
    return null;
  }
  return trimmed;
}

export function inferColumnTypes(rows: string[][]): ColumnType[] {
  const columnCount = Math.max(0, ...rows.map((r) => r.length));
  const types: ColumnType[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    let type: ColumnType = "number";
    for (const row of rows) {
      const raw = row[c]?.trim() ?? "";
      if (raw === "") continue;
      if (type === "number" && raw !== "" && !Number.isFinite(Number(raw))) {
        type = "string";
      }
      if (type === "string") break;
    }
    types.push(type);
  }
  return types;
}

export function coerceRow(row: string[], types: ColumnType[]): CellValue[] {
  return types.map((type, index) => toCell(row[index] ?? "", type));
}

export function sheetFromRows(name: string, rawRows: string[][]): TabularSheet {
  const { header, dataRows } = detectHeader(rawRows);
  const types = inferColumnTypes(dataRows);
  const columns = header.map((h, i) => ({ name: h.trim() || `col${i + 1}`, type: types[i] ?? "string" }));
  const rows = dataRows.map((row) => coerceRow(row, types));
  return { name, columns, rows };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter agent test -- tabular/parse-csv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/tabular
git commit -m "feat(agent): tabular types + RFC 4180 CSV parser"
```

---

### Task 2: XLSX parser

**Files:**
- Create: `packages/agent/src/tools/tabular/parse-xlsx.ts`
- Test: `packages/agent/src/tools/tabular/parse-xlsx.test.ts`

**Interfaces:**
- Consumes: `sheetFromRows` (Task 1)
- Produces: `parseXlsx(buffer: Uint8Array, filename?: string): Promise<TabularSheet[]>` — one sheet per worksheet, name = sheet name (fallback `Sheet<i>`).

- [ ] **Step 1: Add dependency**

Run: `pnpm --filter agent add read-excel-file`
Expected: dependency added.

- [ ] **Step 2: Write the failing test**

`packages/agent/src/tools/tabular/parse-xlsx.test.ts`:

```ts
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
```

Also create the fixture (minimal xlsx, one numeric column, one string column) at `packages/agent/src/tools/tabular/fixtures/multi-sheet.xlsx`. If no binary fixture is available yet, generate it in Task 11's fixture step; for this task, commit a tiny valid xlsx produced by any tool (e.g., Excel/LibreOffice or the `read-excel-file` author's sample). Keep it < 5 KB.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter agent test -- tabular/parse-xlsx`
Expected: FAIL — `parseXlsx` not exported.

- [ ] **Step 4: Implement**

`packages/agent/src/tools/tabular/parse-xlsx.ts`:

```ts
import readXlsxFile from "read-excel-file";
import { sheetFromRows } from "./parse-csv.js";
import type { TabularSheet } from "./types.js";

export async function parseXlsx(
  buffer: Uint8Array,
  filename?: string,
): Promise<TabularSheet[]> {
  const workbook = await readXlsxFile(buffer, { sheet: undefined });
  const sheets: TabularSheet[] = [];
  const { default: readSheet } = await import("read-excel-file");
  // readXlsxFile(data) without a sheet returns only the first sheet; iterate
  // by reading each sheet name for multi-sheet files.
  const sheetNames = await readXlsxFile(buffer, { getSheets: true }).then(
    (meta) => (Array.isArray(meta) ? [] : (meta as { name: string }[])),
  );
  for (const meta of sheetNames) {
    const rows = await readSheet(buffer, { sheet: meta.name });
    if (rows.length === 0) continue;
    sheets.push(
      sheetFromRows(meta.name || filename || `Sheet${sheets.length + 1}`, rows),
    );
  }
  if (sheets.length === 0) {
    const rows = await readXlsxFile(buffer);
    if (rows.length > 0) sheets.push(sheetFromRows(filename ?? "Sheet1", rows));
  }
  return sheets;
}
```

Note: verify `read-excel-file`'s exact API from its installed types (single-sheet default vs `getSheets`), and adjust — the interface contract is what matters: `parseXlsx(bytes) -> Promise<TabularSheet[]>`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter agent test -- tabular/parse-xlsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/tools/tabular/parse-xlsx.ts packages/agent/src/tools/tabular/parse-xlsx.test.ts packages/agent/src/tools/tabular/fixtures
git commit -m "feat(agent): xlsx parser (multi-sheet)"
```

---

### Task 3: Markdown table extraction

**Files:**
- Create: `packages/agent/src/tools/tabular/markdown-tables.ts`
- Test: `packages/agent/src/tools/tabular/markdown-tables.test.ts`

**Interfaces:**
- Consumes: `sheetFromRows` (Task 1)
- Produces: `extractMarkdownTables(markdown: string): { columns: string[]; rows: string[][] }[]`

- [ ] **Step 1: Write the failing test**

`packages/agent/src/tools/tabular/markdown-tables.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter agent test -- tabular/markdown-tables`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/agent/src/tools/tabular/markdown-tables.ts`:

```ts
export type MarkdownTable = { columns: string[]; rows: string[][] };

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

export function extractMarkdownTables(markdown: string): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (TABLE_ROW.test(lines[i]!)) {
      const start = i;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) i += 1;
      const block = lines.slice(start, i);
      const cells = (line: string) =>
        line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());
      const header = cells(block[0]!);
      if (block.length < 2 || !SEPARATOR.test(block[1]!)) continue;
      const rows = block
        .slice(2)
        .map(cells)
        .filter((row) => row.some((cell) => cell !== ""));
      if (header.some((cell) => cell !== "")) tables.push({ columns: header, rows });
    } else {
      i += 1;
    }
  }
  return tables;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter agent test -- tabular/markdown-tables`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/tabular/markdown-tables.ts packages/agent/src/tools/tabular/markdown-tables.test.ts
git commit -m "feat(agent): GFM markdown table extraction"
```

---

### Task 4: Chart spec + pure analysis operations

**Files:**
- Create: `packages/agent/src/tools/tabular/chart-spec.ts`
- Create: `packages/agent/src/tools/tabular/tabular-analysis.ts`
- Modify: `packages/agent/src/tools/data-analysis.ts` (export `pearsonCorrelation`)
- Test: `packages/agent/src/tools/tabular/tabular-analysis.test.ts`

**Interfaces:**
- Consumes: `TabularSheet`, `CellValue`, `TabularColumn` (Task 1)
- Produces:
  - `type ChartSpec = ...` (below)
  - `type AnalysisOperation` (below)
  - `type AnalysisResult = { operation: string; summary: string; result?: { columns: TabularColumn[]; rows: CellValue[][]; rowCount: number; truncated: boolean }; chart?: ChartSpec }`
  - `runAnalysis(sheet: TabularSheet, operation: AnalysisOperation, limits?: { maxRows?: number }): AnalysisResult`

- [ ] **Step 1: Write the failing tests**

`packages/agent/src/tools/tabular/tabular-analysis.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TabularSheet } from "./types.js";
import { runAnalysis } from "./tabular-analysis.js";

const SHEET: TabularSheet = {
  name: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["east", 100],
    ["east", 200],
    ["west", 50],
    ["west", 150],
  ],
};

describe("runAnalysis", () => {
  it("aggregates with groupBy and returns a bar chart", () => {
    const result = runAnalysis(SHEET, {
      op: "aggregate",
      groupBy: ["region"],
      metrics: [{ column: "revenue", fn: "mean" }],
    });
    expect(result.chart?.kind).toBe("bar");
    expect(result.result?.rows).toEqual([
      ["east", 150],
      ["west", 100],
    ]);
  });

  it("computes correlation with a scatter chart", () => {
    const sheet: TabularSheet = {
      name: "xy",
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: [
        [1, 2],
        [2, 4],
        [3, 6],
      ],
    };
    const result = runAnalysis(sheet, { op: "correlation", x: "x", y: "y" });
    expect(result.chart?.kind).toBe("scatter");
    expect(result.result).toBeUndefined();
    expect(result.summary).toMatch(/1/);
  });

  it("filters rows", () => {
    const result = runAnalysis(SHEET, {
      op: "filter",
      column: "revenue",
      predicate: "gte",
      value: 100,
    });
    expect(result.result?.rows).toHaveLength(3);
  });

  it("profiles a numeric column with a histogram", () => {
    const result = runAnalysis(SHEET, { op: "profile", column: "revenue" });
    expect(result.chart?.kind).toBe("histogram");
    expect(result.summary).toMatch(/count/);
  });

  it("returns an explicit message when a column is all null", () => {
    const sheet: TabularSheet = {
      name: "bad",
      columns: [{ name: "x", type: "number" }],
      rows: [[null], [null]],
    };
    const result = runAnalysis(sheet, { op: "profile", column: "x" });
    expect(result.summary.toLowerCase()).toContain("no usable data");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter agent test -- tabular/tabular-analysis`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/agent/src/tools/tabular/chart-spec.ts`:

```ts
export type ChartSpec =
  | {
      kind: "bar";
      labels: string[];
      series: { name: string; values: number[] }[];
      xLabel?: string;
      yLabel?: string;
    }
  | {
      kind: "line";
      labels: string[];
      series: { name: string; values: number[] }[];
      xLabel?: string;
      yLabel?: string;
    }
  | { kind: "scatter"; points: { x: number; y: number }[]; xLabel?: string; yLabel?: string }
  | { kind: "histogram"; bins: { min: number; max: number; count: number }[]; label?: string };
```

Modify `packages/agent/src/tools/data-analysis.ts` — change the private helper to an export (keep behavior identical):

```ts
export function pearsonCorrelation(x: number[], y: number[]) {
```

`packages/agent/src/tools/tabular/tabular-analysis.ts`:

```ts
import { pearsonCorrelation } from "../data-analysis.js";
import type { CellValue, ColumnType, TabularColumn, TabularSheet } from "./types.js";
import type { ChartSpec } from "./chart-spec.js";

export type AnalysisOperation =
  | { op: "profile"; column?: string }
  | {
      op: "aggregate";
      groupBy: string[];
      metrics: { column: string; fn: "sum" | "mean" | "count" | "min" | "max" | "median" }[];
    }
  | { op: "filter"; column: string; predicate: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains"; value: CellValue }
  | { op: "sort"; column: string; order: "asc" | "desc" }
  | { op: "top_n"; column: string; n: number }
  | { op: "correlation"; x: string; y: string }
  | { op: "trend"; x: string; y: string };

export type AnalysisResult = {
  operation: string;
  summary: string;
  result?: { columns: TabularColumn[]; rows: CellValue[][]; rowCount: number; truncated: boolean };
  chart?: ChartSpec;
};

const DEFAULT_LIMITS = { maxRows: 500 };

function columnIndex(sheet: TabularSheet, name: string): number {
  const index = sheet.columns.findIndex((c) => c.name === name);
  if (index < 0) throw new Error(`Unknown column: ${name}`);
  return index;
}

function numericValues(sheet: TabularSheet, name: string): number[] {
  const index = columnIndex(sheet, name);
  return sheet.rows
    .map((row) => row[index])
    .filter((v): v is number => typeof v === "number");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function table(
  columns: TabularColumn[],
  rows: CellValue[][],
  limits: { maxRows: number },
) {
  const truncated = rows.length > limits.maxRows;
  return {
    columns,
    rows: truncated ? rows.slice(0, limits.maxRows) : rows,
    rowCount: rows.length,
    truncated,
  };
}

export function runAnalysis(
  sheet: TabularSheet,
  operation: AnalysisOperation,
  limits = DEFAULT_LIMITS,
): AnalysisResult {
  switch (operation.op) {
    case "aggregate": {
      const groupIndexes = operation.groupBy.map((name) => columnIndex(sheet, name));
      const metricIndexes = operation.metrics.map((m) => ({ m, index: columnIndex(sheet, m.column) }));
      const groups = new Map<string, CellValue[][]>();
      for (const row of sheet.rows) {
        const key = groupIndexes.map((i) => String(row[i] ?? "")).join("\u0001");
        const bucket = groups.get(key) ?? [];
        bucket.push(row);
        groups.set(key, bucket);
      }
      const outRows: CellValue[][] = [];
      for (const [key, bucket] of groups) {
        const groupCells = key.split("\u0001");
        const metricCells: CellValue[] = [];
        for (const { m, index } of metricIndexes) {
          const values = bucket
            .map((row) => row[index])
            .filter((v): v is number => typeof v === "number");
          if (m.fn === "count") metricCells.push(bucket.length);
          else if (m.fn === "sum") metricCells.push(values.reduce((a, b) => a + b, 0));
          else if (m.fn === "mean") metricCells.push(values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
          else if (m.fn === "min") metricCells.push(values.length ? Math.min(...values) : null);
          else if (m.fn === "max") metricCells.push(values.length ? Math.max(...values) : null);
          else metricCells.push(values.length ? median(values) : null);
        }
        outRows.push([...groupCells, ...metricCells]);
      }
      const columns: TabularColumn[] = [
        ...operation.groupBy.map((name) => sheet.columns[columnIndex(sheet, name)]!),
        ...operation.metrics.map((m) => ({
          name: `${m.fn}(${m.column})`,
          type: "number" as const,
        })),
      ];
      const firstMetric = operation.metrics[0];
      const chart: ChartSpec | undefined =
        outRows.length > 0 && firstMetric
          ? {
              kind: "bar",
              labels: outRows.map((row) => String(row[0] ?? "")),
              series: [
                {
                  name: `${firstMetric.fn}(${firstMetric.column})`,
                  values: outRows.map((row) => {
                    const v = row[groupIndexes.length]!;
                    return typeof v === "number" ? v : 0;
                  }),
                },
              ],
              yLabel: firstMetric.column,
            }
          : undefined;
      return {
        operation: "aggregate",
        summary: `${groups.size} group${groups.size === 1 ? "" : "s"} · ${outRows.length} row${outRows.length === 1 ? "" : "s"}`,
        result: table(columns, outRows, limits),
        chart,
      };
    }
    case "correlation": {
      const x = numericValues(sheet, operation.x);
      const y = numericValues(sheet, operation.y);
      const r = pearsonCorrelation(x, y);
      return {
        operation: "correlation",
        summary: `r = ${r.toFixed(4)} (${r >= 0 ? "positive" : "negative"}, ${Math.abs(r) >= 0.7 ? "strong" : Math.abs(r) >= 0.4 ? "moderate" : "weak"})`,
        chart: { kind: "scatter", points: x.map((xi, i) => ({ x: xi, y: y[i]! })), xLabel: operation.x, yLabel: operation.y },
      };
    }
    case "trend": {
      const xi = columnIndex(sheet, operation.x);
      const yi = columnIndex(sheet, operation.y);
      const points = sheet.rows
        .map((row) => ({ x: row[xi], y: row[yi] }))
        .filter((p): p is { x: number; y: number } => typeof p.x === "number" && typeof p.y === "number")
        .sort((a, b) => a.x - b.x);
      return {
        operation: "trend",
        summary: `${points.length} points sorted by ${operation.x}`,
        chart: { kind: "line", labels: points.map((p) => String(p.x)), series: [{ name: operation.y, values: points.map((p) => p.y) }], xLabel: operation.x, yLabel: operation.y },
      };
    }
    case "top_n": {
      const index = columnIndex(sheet, operation.column);
      const sorted = [...sheet.rows]
        .map((row) => row[index])
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => b - a)
        .slice(0, operation.n);
      const labels = sorted.map((v) => String(v));
      return {
        operation: "top_n",
        summary: `top ${sorted.length} of ${operation.column}`,
        chart: { kind: "bar", labels, series: [{ name: operation.column, values: sorted }], yLabel: operation.column },
      };
    }
    case "filter": {
      const index = columnIndex(sheet, operation.column);
      const value = operation.value;
      const match = (cell: CellValue): boolean => {
        if (operation.predicate === "contains") {
          return typeof cell === "string" && String(value) !== "" && cell.toLowerCase().includes(String(value).toLowerCase());
        }
        if (operation.predicate === "eq") return cell === value || String(cell ?? "") === String(value);
        if (operation.predicate === "neq") return cell !== value;
        const n = typeof cell === "number" ? cell : Number(cell);
        const v = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n) || !Number.isFinite(v)) return false;
        switch (operation.predicate) {
          case "gt": return n > v;
          case "gte": return n >= v;
          case "lt": return n < v;
          case "lte": return n <= v;
          default: return false;
        }
      };
      const rows = sheet.rows.filter((row) => match(row[index]));
      return {
        operation: "filter",
        summary: `${rows.length} of ${sheet.rows.length} rows matched`,
        result: table(sheet.columns, rows, limits),
      };
    }
    case "sort": {
      const index = columnIndex(sheet, operation.column);
      const sign = operation.order === "desc" ? -1 : 1;
      const rows = [...sheet.rows].sort((a, b) => {
        const av = a[index]; const bv = b[index];
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
        return String(av ?? "").localeCompare(String(bv ?? "")) * sign;
      });
      return { operation: "sort", summary: `sorted by ${operation.column} (${operation.order})`, result: table(sheet.columns, rows, limits) };
    }
    case "profile": {
      if (operation.column) {
        const index = columnIndex(sheet, operation.column);
        const values = numericValues(sheet, operation.column);
        if (values.length === 0) {
          return { operation: "profile", summary: `No usable data in column "${operation.column}" (all values non-numeric or empty)` };
        }
        const sorted = [...values].sort((a, b) => a - b);
        const min = sorted[0]!; const max = sorted[sorted.length - 1]!;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
        const binCount = Math.min(10, values.length);
        const binWidth = (max - min) / binCount || 1;
        const bins = Array.from({ length: binCount }, (_, i) => ({
          min: min + i * binWidth,
          max: min + (i + 1) * binWidth,
          count: 0,
        }));
        for (const v of values) {
          const b = Math.min(binCount - 1, Math.floor((v - min) / binWidth));
          bins[b]!.count += 1;
        }
        return {
          operation: "profile",
          summary: `${operation.column}: n=${values.length}, mean=${mean.toFixed(2)}, min=${min}, max=${max}, q1=${q(0.25).toFixed(2)}, median=${q(0.5).toFixed(2)}, q3=${q(0.75).toFixed(2)}`,
          chart: { kind: "histogram", bins, label: operation.column },
        };
      }
      return { operation: "profile", summary: `profile of all columns (n=${sheet.rows.length})`, result: table(sheet.columns, sheet.rows.slice(0, 10), limits) };
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter agent test -- tabular/tabular-analysis`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/tabular packages/agent/src/tools/data-analysis.ts
git commit -m "feat(agent): chart spec + deterministic analysis operations"
```

---

### Task 5: Read-only DuckDB SQL runner

**Files:**
- Create: `packages/agent/src/tools/tabular/sql.ts`
- Test: `packages/agent/src/tools/tabular/sql.test.ts`

**Interfaces:**
- Consumes: `TabularSheet` (Task 1)
- Produces:
  - `assertReadOnlySql(query: string): void` — throws on DDL/DML/multiple statements/`;`
  - `type SqlResult = { columns: string[]; rows: (string | number | null)[][]; rowCount: number; truncated: boolean }`
  - `type SqlRunner = (sheet: TabularSheet, query: string, opts?: { maxRows?: number; timeoutMs?: number }) => Promise<SqlResult>`
  - `createDuckDbRunner(): SqlRunner` — lazy-imports `duckdb`, registers the sheet as an in-memory table, runs the query read-only, enforces caps.

- [ ] **Step 1: Add dependency**

Run: `pnpm --filter agent add duckdb`
Expected: dependency added.

- [ ] **Step 2: Write the failing tests**

`packages/agent/src/tools/tabular/sql.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertReadOnlySql, createDuckDbRunner } from "./sql.js";
import type { TabularSheet } from "./types.js";

describe("assertReadOnlySql", () => {
  it("accepts SELECT and WITH ... SELECT", () => {
    expect(() => assertReadOnlySql("SELECT * FROM t")).not.toThrow();
    expect(() => assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).not.toThrow();
  });
  it("rejects DDL/DML and multiple statements", () => {
    expect(() => assertReadOnlySql("DELETE FROM t")).toThrow();
    expect(() => assertReadOnlySql("DROP TABLE t")).toThrow();
    expect(() => assertReadOnlySql("INSERT INTO t VALUES (1)")).toThrow();
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow();
  });
});

describe("createDuckDbRunner", () => {
  it("runs a SELECT over the sheet and caps rows", async () => {
    const sheet: TabularSheet = {
      name: "sales",
      columns: [
        { name: "region", type: "string" },
        { name: "revenue", type: "number" },
      ],
      rows: Array.from({ length: 20 }, (_, i) => [i % 2 === 0 ? "east" : "west", i]),
    };
    const runner = createDuckDbRunner();
    const result = await runner(sheet, "SELECT region, SUM(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC", { maxRows: 5 });
    expect(result.columns).toEqual(["region", "total"]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    await expect(
      runner(sheet, "DELETE FROM sales", {}),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter agent test -- tabular/sql`
Expected: FAIL — `assertReadOnlySql`/`createDuckDbRunner` not exported.

- [ ] **Step 4: Implement**

`packages/agent/src/tools/tabular/sql.ts`:

```ts
import type { CellValue, TabularSheet } from "./types.js";

const STATEMENT_RE = /^\s*(with\s+\w|select)\b/i;

export function assertReadOnlySql(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Query is empty");
  if (trimmed.includes(";")) throw new Error("Only a single statement is allowed");
  if (!STATEMENT_RE.test(trimmed)) {
    throw new Error("Only SELECT / WITH ... SELECT queries are allowed");
  }
}

export type SqlResult = {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  truncated: boolean;
};

export type SqlRunner = (
  sheet: TabularSheet,
  query: string,
  opts?: { maxRows?: number; timeoutMs?: number },
) => Promise<SqlResult>;

export function createDuckDbRunner(): SqlRunner {
  return async (sheet, query, opts = {}) => {
    const { maxRows = 500, timeoutMs = 10_000 } = opts;
    assertReadOnlySql(query);
    const duckdb = await import("duckdb");
    const db = new duckdb.Database(":memory:");
    try {
      const create = `CREATE TABLE t (${sheet.columns
        .map((c) => `${JSON.stringify(c.name)} ${c.type === "number" ? "DOUBLE" : c.type === "boolean" ? "BOOLEAN" : "VARCHAR"}`)
        .join(", ")})`;
      await new Promise<void>((resolve, reject) =>
        db.exec(create, (err) => (err ? reject(err) : resolve())),
      );
      const stmt = db.prepare(
        `INSERT INTO t VALUES (${sheet.columns.map(() => "?").join(", ")})`,
      );
      for (const row of sheet.rows) await stmt.run(...row);
      const select = `SELECT * FROM (${query.replace(/;\s*$/, "")}) AS q LIMIT ${maxRows}`;
      const rows = await new Promise<unknown[][]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SQL timed out")), timeoutMs);
        db.all(select, (err, res) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(res as unknown[][]);
        });
      });
      const columns = Object.keys((rows[0] ?? {}) as object).length
        ? Object.keys(rows[0]!)
        : sheet.columns.map((c) => c.name);
      const cells = rows.map((row) =>
        Object.values(row as Record<string, unknown>).map(normalizeCell),
      );
      return {
        columns,
        rows: cells,
        rowCount: cells.length,
        truncated: cells.length >= maxRows,
      };
    } finally {
      db.close();
    }
  };
}

function normalizeCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return String(value);
}

export { type CellValue };
```

Note: the DuckDB API differs across versions — verify against the installed `duckdb` types (`new Database`, `exec`, `prepare().run()`, `all`, `close`). The contract that matters: `SqlRunner` returns `{ columns, rows, rowCount, truncated }` and enforces read-only + caps.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter agent test -- tabular/sql`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/tools/tabular/sql.ts packages/agent/src/tools/tabular/sql.test.ts
git commit -m "feat(agent): read-only DuckDB SQL runner"
```

---

### Task 6: Dataset resolver + the four tabular tools

**Files:**
- Create: `packages/agent/src/tools/tabular/tools.ts`
- Test: `packages/agent/src/tools/tabular/tools.test.ts`
- Modify: `packages/agent/src/index.ts` (export tabular modules)

**Interfaces:**
- Consumes: `TabularSheet`, `DatasetRef` (Task 1), `sheetFromRows` (Task 1), `extractMarkdownTables` (Task 3), `runAnalysis`, `AnalysisOperation`, `ChartSpec` (Task 4), `SqlRunner` (Task 5)
- Produces:
  - `interface DatasetResolver { listUploads(): Promise<{ documentId: string; filename: string; sheets: { name: string; columns: {name:string;type:string}[]; rowCount: number }[] }[]>; resolveSheet(ref: DatasetRef): Promise<TabularSheet>; listDocumentTables(): Promise<{ documentId: string; filename: string; pageIndex: number; tableIndex: number; columns: {name:string;type:string}[]; rowCount: number }[]> }`
  - `createTabularAnalysisTools(deps: { resolver: DatasetResolver; sqlRunner: SqlRunner; limits?: { maxRows?: number } }): AnyTool[]`

- [ ] **Step 1: Write the failing tests**

`packages/agent/src/tools/tabular/tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { TabularSheet } from "./types.js";
import { createTabularAnalysisTools, type DatasetResolver } from "./tools.js";

const SHEET: TabularSheet = {
  name: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["east", 100],
    ["west", 200],
  ],
};

function makeResolver(): DatasetResolver {
  return {
    listUploads: async () => [
      { documentId: "d1", filename: "sales.csv", sheets: [{ name: "sales", columns: SHEET.columns, rowCount: 2 }] },
    ],
    resolveSheet: async (ref) => {
      expect(ref).toEqual({ type: "upload", documentId: "d1" });
      return SHEET;
    },
    listDocumentTables: async () => [],
  };
}

describe("tabular tools", () => {
  it("read_dataset returns schema + preview", async () => {
    const [tool] = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never });
    const out = await tool!.call({ source: { type: "upload", documentId: "d1" } });
    const text = Array.isArray(out) ? out.find((p) => p.type === "text")?.text : out;
    expect(JSON.parse(String(text))).toMatchObject({
      name: "sales",
      rowCount: 2,
      columns: [
        { name: "region", type: "string" },
        { name: "revenue", type: "number" },
      ],
    });
  });

  it("analyze_dataset returns a chart in output", async () => {
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never });
    const tool = tools.find((t) => t.name === "analyze_dataset")!;
    const out = await tool.call({
      source: { type: "upload", documentId: "d1" },
      operation: { op: "aggregate", groupBy: ["region"], metrics: [{ column: "revenue", fn: "sum" }] },
    });
    const text = Array.isArray(out) ? out.find((p) => p.type === "text")?.text : out;
    expect(JSON.parse(String(text))).toMatchObject({ operation: "aggregate", chart: { kind: "bar" } });
  });

  it("query_dataset_sql delegates to the sql runner", async () => {
    const sqlRunner = vi.fn(async () => ({
      columns: ["region", "total"],
      rows: [["east", 100]],
      rowCount: 1,
      truncated: false,
    }));
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner });
    const tool = tools.find((t) => t.name === "query_dataset_sql")!;
    const out = await tool.call({ source: { type: "upload", documentId: "d1" }, query: "SELECT * FROM sales" });
    expect(sqlRunner).toHaveBeenCalled();
    const text = Array.isArray(out) ? out.find((p) => p.type === "text")?.text : out;
    expect(JSON.parse(String(text))).toMatchObject({ rowCount: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter agent test -- tabular/tools`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/agent/src/tools/tabular/tools.ts`:

```ts
import { createTool, type AnyTool } from "@anvia/core";
import { z } from "zod";
import { extractMarkdownTables } from "./markdown-tables.js";
import { runAnalysis, type AnalysisOperation } from "./tabular-analysis.js";
import { sheetFromRows } from "./parse-csv.js";
import type { SqlRunner } from "./sql.js";
import type { TabularSheet } from "./types.js";

export interface DatasetResolver {
  listUploads(): Promise<
    Array<{
      documentId: string;
      filename: string;
      sheets: Array<{ name: string; columns: Array<{ name: string; type: string }>; rowCount: number }>;
    }>
  >;
  resolveSheet(ref: { type: "upload"; documentId: string; sheet?: string } | { type: "document_table"; documentId: string; pageIndex: number; tableIndex: number }): Promise<TabularSheet>;
  listDocumentTables(): Promise<
    Array<{
      documentId: string;
      filename: string;
      pageIndex: number;
      tableIndex: number;
      columns: Array<{ name: string; type: string }>;
      rowCount: number;
    }>
  >;
}

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upload"), documentId: z.string().min(1), sheet: z.string().optional() }),
  z.object({ type: z.literal("document_table"), documentId: z.string().min(1), pageIndex: z.number().int().min(0), tableIndex: z.number().int().min(0) }),
]);

export type TabularToolDeps = {
  resolver: DatasetResolver;
  sqlRunner: SqlRunner;
  limits?: { maxRows?: number };
};

export function createTabularAnalysisTools(deps: TabularToolDeps): AnyTool[] {
  const { resolver, sqlRunner, limits } = deps;

  const readDataset = createTool({
    name: "read_dataset",
    description:
      "Inspect a tabular dataset (CSV/XLSX upload or a table extracted from a document): returns the sheet name, row count, column names+types, and a preview of the first rows. Call this first to understand the data before analyzing.",
    input: z.object({ source: sourceSchema.describe("Which dataset to inspect") }),
    execute: async ({ source }) => {
      const sheet = await resolver.resolveSheet(source);
      return {
        name: sheet.name,
        rowCount: sheet.rows.length,
        columns: sheet.columns,
        preview: sheet.rows.slice(0, 10),
      };
    },
  });

  const analyzeDataset = createTool({
    name: "analyze_dataset",
    description:
      "Run a deterministic data-analysis operation on a dataset: profile (per-column stats + histogram), aggregate (groupBy + sum/mean/count/min/max/median + bar chart), filter, sort, top_n, correlation between two numeric columns (scatter), or trend (line). Returns structured results and a chart spec the UI renders.",
    input: z.object({
      source: sourceSchema,
      operation: z.custom<AnalysisOperation>(),
    }),
    execute: async ({ source, operation }) => {
      const sheet = await resolver.resolveSheet(source);
      return runAnalysis(sheet, operation, limits);
    },
  });

  const queryDatasetSql = createTool({
    name: "query_dataset_sql",
    description:
      "Run a read-only SQL SELECT query over a dataset using DuckDB. The table is named after the sheet (or use t). Only SELECT / WITH ... SELECT is allowed. Results are capped. Use for ad-hoc questions; prefer analyze_dataset for charts.",
    input: z.object({
      source: sourceSchema,
      query: z.string().min(1).describe("Read-only SQL SELECT query"),
    }),
    execute: async ({ source, query }) => {
      const sheet = await resolver.resolveSheet(source);
      return sqlRunner(sheet, query, limits);
    },
  });

  const extractDocumentTables = createTool({
    name: "extract_document_tables",
    description:
      "Discover GFM markdown tables inside the linked ready documents (e.g. tables OCR'd from PDFs). Returns each table's location (documentId, pageIndex, tableIndex), columns and row count so you can feed it back as a source to read_dataset / analyze_dataset / query_dataset_sql.",
    input: z.object({}),
    execute: async () => {
      return { tables: await resolver.listDocumentTables() };
    },
  });

  return [readDataset, analyzeDataset, queryDatasetSql, extractDocumentTables];
}
```

`packages/agent/src/index.ts` — add exports:

```ts
export * from "./tools/tabular/types.js";
export * from "./tools/tabular/chart-spec.js";
export * from "./tools/tabular/parse-csv.js";
export * from "./tools/tabular/parse-xlsx.js";
export * from "./tools/tabular/markdown-tables.js";
export * from "./tools/tabular/tabular-analysis.js";
export * from "./tools/tabular/sql.js";
export * from "./tools/tabular/tools.js";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter agent test -- tabular/tools`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/tabular/tools.ts packages/agent/src/tools/tabular/tools.test.ts packages/agent/src/index.ts
git commit -m "feat(agent): tabular analysis tools (read/analyze/sql/extract-tables)"
```

---

### Task 7: API — schema, allowlist, ingest branch, resolver, wiring

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/modules/documents/service.ts`
- Modify: `apps/api/src/worker.ts`
- Create: `apps/api/src/modules/chat/tabular-resolver.ts`
- Modify: `apps/api/src/modules/chat/build-run-input.ts`
- Test: `apps/api/src/modules/chat/tabular-resolver.test.ts`

**Interfaces:**
- Consumes: `DatasetResolver` (Task 6), `parseXlsx`/`sheetFromRows` (Tasks 1-2), `extractMarkdownTables` (Task 3)
- Produces:
  - Prisma: `Document.tabularData Json?`
  - `createTabularResolver(deps: { userId: string; sessionId: string; projectId?: string | null; prisma: PrismaClient }): DatasetResolver`
  - Ingest: tabular MIME branch in `processDocumentIngest`

- [ ] **Step 1: Schema + migration**

Add to `Document` in `apps/api/prisma/schema.prisma`:

```prisma
/// Structured tabular data for CSV/XLSX: { sheets: TabularSheet[] }.
tabularData Json?
```

Run: `pnpm --filter api db:generate && pnpm --filter api db:migrate --name add_document_tabular_data`
Expected: migration applied.

- [ ] **Step 2: Allowlist + caps (`service.ts`)**

In `apps/api/src/modules/documents/service.ts`, extend the allowlist and add **exported** caps (the worker imports them for parse-time enforcement):

```ts
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export const MAX_TABULAR_ROWS = 50_000;
export const MAX_TABULAR_COLUMNS = 100;
```

- [ ] **Step 3: Write the resolver test**

`apps/api/src/modules/chat/tabular-resolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTabularResolver } from "./tabular-resolver.js";

function prismaMock(overrides: Record<string, unknown>) {
  return overrides as never;
}

describe("tabular resolver", () => {
  it("resolves an upload sheet from Document.tabularData", async () => {
    const prisma = prismaMock({
      document: {
        findFirst: async () => ({
          id: "d1",
          filename: "sales.csv",
          mimeType: "text/csv",
          tabularData: {
            sheets: [
              {
                name: "sales",
                columns: [{ name: "region", type: "string" }],
                rows: [["east"], ["west"]],
              },
            ],
          },
        }),
      },
      documentPage: { findFirst: async () => null },
      documentSession: { findMany: async () => [{ documentId: "d1" }] },
    });
    const resolver = createTabularResolver({
      userId: "u1",
      sessionId: "s1",
      projectId: null,
      prisma,
    });
    const sheet = await resolver.resolveSheet({ type: "upload", documentId: "d1" });
    expect(sheet.name).toBe("sales");
    expect(sheet.rows).toEqual([["east"], ["west"]]);
  });

  it("parses document tables from a page's rawMarkdown on demand", async () => {
    const prisma = prismaMock({
      document: { findFirst: async () => null },
      documentPage: {
        findFirst: async () => ({ rawMarkdown: "| a | b |\n| - | - |\n| 1 | 2 |\n" }),
      },
      documentSession: { findMany: async () => [{ documentId: "d1" }] },
    });
    const resolver = createTabularResolver({ userId: "u1", sessionId: "s1", projectId: null, prisma });
    const sheet = await resolver.resolveSheet({
      type: "document_table",
      documentId: "d1",
      pageIndex: 0,
      tableIndex: 0,
    });
    expect(sheet.columns[0]!.name).toBe("a");
    expect(sheet.rows[0]).toEqual([1, 2]);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter api test -- tabular-resolver`
Expected: FAIL.

- [ ] **Step 5: Implement resolver**

`apps/api/src/modules/chat/tabular-resolver.ts`:

```ts
import type { DatasetResolver, TabularSheet } from "@assingment/agent";
import { extractMarkdownTables, sheetFromRows } from "@assingment/agent";
import type { PrismaClient } from "../../generated/prisma/client.js";

type TabularData = { sheets: TabularSheet[] };

export type TabularResolverDeps = {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: PrismaClient;
};

export function createTabularResolver(deps: TabularResolverDeps): DatasetResolver {
  const { userId, sessionId, projectId, prisma } = deps;

  async function linkedDocumentIds(): Promise<string[]> {
    const rows = await prisma.documentSession.findMany({
      where: {
        sessionId,
        userId,
        document: { status: "ready", userId, ...(projectId ? { projectId } : {}) },
      },
      select: { documentId: true },
    });
    return rows.map((r) => r.documentId);
  }

  return {
    async listUploads() {
      const ids = await linkedDocumentIds();
      if (ids.length === 0) return [];
      const docs = await prisma.document.findMany({
        where: { id: { in: ids }, tabularData: { not: null } },
        select: { id: true, filename: true, tabularData: true },
      });
      return docs.map((doc) => {
        const sheets = ((doc.tabularData as TabularData | null)?.sheets ?? []).map((s) => ({
          name: s.name,
          columns: s.columns,
          rowCount: s.rows.length,
        }));
        return { documentId: doc.id, filename: doc.filename, sheets };
      });
    },

    async resolveSheet(ref) {
      if (ref.type === "upload") {
        const doc = await prisma.document.findFirst({
          where: { id: ref.documentId, userId, ...(projectId ? { projectId } : {}) },
          select: { tabularData: true },
        });
        const sheets = (doc?.tabularData as TabularData | null)?.sheets ?? [];
        if (ref.sheet) {
          const match = sheets.find((s) => s.name === ref.sheet);
          if (match) return match;
        }
        const first = sheets[0];
        if (!first) throw new Error("Dataset not found or empty");
        return first;
      }
      const page = await prisma.documentPage.findFirst({
        where: { document: { id: ref.documentId, userId, status: "ready" }, pageIndex: ref.pageIndex },
        select: { rawMarkdown: true },
      });
      const tables = page ? extractMarkdownTables(page.rawMarkdown) : [];
      const table = tables[ref.tableIndex];
      if (!table) throw new Error("Table not found");
      return sheetFromRows(`doc-table-${ref.tableIndex + 1}`, [
        table.columns,
        ...table.rows,
      ]);
    },

    async listDocumentTables() {
      const ids = await linkedDocumentIds();
      const out: Array<{
        documentId: string;
        filename: string;
        pageIndex: number;
        tableIndex: number;
        columns: Array<{ name: string; type: string }>;
        rowCount: number;
      }> = [];
      if (ids.length === 0) return out;
      const docs = await prisma.document.findMany({
        where: { id: { in: ids }, status: "ready" },
        select: { id: true, filename: true, pages: { select: { pageIndex: true, rawMarkdown: true }, orderBy: { pageIndex: "asc" } } },
      });
      for (const doc of docs) {
        for (const page of doc.pages) {
          const tables = extractMarkdownTables(page.rawMarkdown);
          tables.forEach((table, tableIndex) => {
            const sheet = sheetFromRows(`t${tableIndex}`, [table.columns, ...table.rows]);
            out.push({
              documentId: doc.id,
              filename: doc.filename,
              pageIndex: page.pageIndex,
              tableIndex,
              columns: sheet.columns,
              rowCount: sheet.rows.length,
            });
          });
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter api test -- tabular-resolver`
Expected: PASS.

- [ ] **Step 7: Ingest tabular branch (`worker.ts`)**

Add a tabular branch at the top of `processDocumentIngest` (before OCR):

```ts
import {
  buildDocumentSummary,
  chunkText,
  deleteDocumentChunks,
  embeddingModel,
  firstLinesSummary,
  parseCsv,
  parseXlsx,
  runDocumentOcr,
  sheetFromRows,
  upsertDocumentChunks,
  type DocumentChunkMetadata,
  type DocumentPageImage,
  type TabularSheet,
} from "@assingment/agent";
import {
  MAX_TABULAR_COLUMNS,
  MAX_TABULAR_ROWS,
} from "./modules/documents/service.js";

const TABULAR_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
```

Then, right after `const fileBuffer = await getObjectBuffer(r2Key);`:

```ts
const mime = (await prisma.document.findUnique({ where: { id: documentId }, select: { mimeType: true } }))?.mimeType ?? "";
if (TABULAR_MIME_TYPES.has(mime)) {
  await processTabularIngest({ documentId, userId, sessionId, filename, mime, fileBuffer });
  return;
}
```

And add the helper (place below `processDocumentIngest`):

```ts
async function processTabularIngest(input: {
  documentId: string;
  userId: string;
  sessionId: string;
  filename: string;
  mime: string;
  fileBuffer: Uint8Array;
}) {
  const { documentId, userId, sessionId, filename, mime, fileBuffer } = input;
  const sheets: TabularSheet[] =
    mime === "text/csv"
      ? [sheetFromRows(filename.replace(/\.csv$/i, ""), parseCsv(Buffer.from(fileBuffer).toString("utf8")))]
      : await parseXlsx(fileBuffer, filename);
  const flattened = sheets.flatMap((s) => s.rows);
  const maxColumns = Math.max(...sheets.map((s) => s.columns.length), 0);
  if (flattened.length === 0) throw new Error("File contains no data rows");
  if (flattened.length > MAX_TABULAR_ROWS) throw new Error(`Too many rows (max ${MAX_TABULAR_ROWS})`);
  if (maxColumns > MAX_TABULAR_COLUMNS) throw new Error(`Too many columns (max ${MAX_TABULAR_COLUMNS})`);

  const first = sheets[0]!;
  const markdown = toMarkdownTable(first);

  await prisma.$transaction(async (tx) => {
    await tx.documentPage.deleteMany({ where: { documentId } });
    await tx.documentPage.create({
      data: {
        documentId,
        pageIndex: 0,
        summary: firstLinesSummary(markdown),
        rawMarkdown: markdown,
      },
    });
    await tx.document.update({
      where: { id: documentId },
      data: {
        pageCount: 1,
        summary: buildDocumentSummary([firstLinesSummary(markdown)]),
        firstPageSummary: firstLinesSummary(markdown),
        tabularData: { sheets } as Prisma.InputJsonValue,
        status: "embedding_processing",
      },
    });
  });

  await deleteDocumentChunks(documentId);
  const chunks = chunkText(markdown);
  if (chunks.length > 0) {
    const vectors = await embeddingModel.embedTexts(chunks.map((c) => c.text));
    await upsertDocumentChunks(
      chunks.map((chunk, i) => ({
        id: `${documentId}:page0:${chunk.chunkIndex}`,
        document: chunk.text,
        embeddings: [{ document: chunk.text, vector: vectors[i]!.vector }],
        metadata: {
          userId, sessionId, documentId, filename,
          pageId: documentId,
          pageIndex: 0,
          chunkIndex: chunk.chunkIndex,
          chunkText: chunk.text,
          documentPageCount: 1,
        },
      })),
    );
  }

  await prisma.document.update({
    where: { id: documentId },
    data: { status: "ready", errorMessage: null },
  });
  console.log(`[worker] tabular ingest ready ${documentId}`);
}

function toMarkdownTable(sheet: TabularSheet): string {
  const header = `| ${sheet.columns.map((c) => c.name).join(" | ")} |`;
  const sep = `| ${sheet.columns.map(() => "---").join(" | ")} |`;
  const body = sheet.rows
    .slice(0, 200)
    .map((row) => `| ${sheet.columns.map((_, i) => String(row[i] ?? "")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}
```

(Add `parseCsv` to the `@assingment/agent` imports; export `parseCsv` in `packages/agent/src/index.ts` — it is already exported from `parse-csv.js`.)

- [ ] **Step 8: Wire tools in `build-run-input.ts`**

Import and register alongside `createDataAnalysisTools()`:

```ts
import { createDuckDbRunner, createTabularAnalysisTools } from "@assingment/agent";
import { createTabularResolver } from "./tabular-resolver.js";
```

In `buildChatRunInput`, after the existing tools array (around `:371-375`):

```ts
const tabularTools = createTabularAnalysisTools({
  resolver: createTabularResolver({ userId, sessionId, projectId, prisma }),
  sqlRunner: createDuckDbRunner(),
});
const tools = [
  ...createDataAnalysisTools(),
  ...tabularTools,
  ...documentTools,
  ...(profileTool ? [profileTool] : []),
];
```

- [ ] **Step 9: Typecheck + run API tests**

Run: `pnpm --filter api test; pnpm --filter agent test`
Expected: both PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/modules/documents/service.ts apps/api/src/worker.ts apps/api/src/modules/chat/tabular-resolver.ts apps/api/src/modules/chat/tabular-resolver.test.ts apps/api/src/modules/chat/build-run-input.ts packages/agent/src/index.ts
git commit -m "feat(api): CSV/XLSX ingest branch, tabular resolver, tool wiring"
```

---

### Task 8: Frontend — data DTOs, DataTable, DataChart

**Files:**
- Create: `apps/platform/src/lib/data-analysis.ts`
- Create: `apps/platform/src/components/data/data-table.tsx`
- Create: `apps/platform/src/components/data/data-chart.tsx`
- Test: `apps/platform/src/components/data/data-chart.test.tsx`
- Test: `apps/platform/src/lib/data-analysis.test.ts`

**Interfaces:**
- Produces:
  - `type ChartSpec` (mirror of agent `chart-spec.ts`)
  - `type TableDto = { columns: { name: string; type: string }[]; rows: (string|number|boolean|null)[][] }`
  - `parseChartSpec(value: unknown): ChartSpec | null` — validates + returns null on bad input
  - `parseTableDto(value: unknown): TableDto | null`
  - `<DataTable columns rows rowCount truncated />`
  - `<DataChart spec={ChartSpec} />`

- [ ] **Step 1: Write the failing tests**

`apps/platform/src/lib/data-analysis.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChartSpec, parseTableDto } from "./data-analysis";

describe("parseChartSpec", () => {
  it("accepts a valid bar chart", () => {
    const spec = parseChartSpec({ kind: "bar", labels: ["a"], series: [{ name: "s", values: [1] }] });
    expect(spec?.kind).toBe("bar");
  });
  it("rejects malformed specs", () => {
    expect(parseChartSpec({ kind: "nope" })).toBeNull();
    expect(parseChartSpec(null)).toBeNull();
  });
});

describe("parseTableDto", () => {
  it("accepts a valid table", () => {
    const t = parseTableDto({ columns: [{ name: "region", type: "string" }], rows: [["east"]] });
    expect(t?.rows).toEqual([["east"]]);
  });
  it("rejects invalid tables", () => {
    expect(parseTableDto({ columns: "x" })).toBeNull();
  });
});
```

`apps/platform/src/components/data/data-chart.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataChart } from "./data-chart";

describe("DataChart", () => {
  it("renders an SVG with an accessible label for a bar chart", () => {
    const html = renderToStaticMarkup(
      <DataChart spec={{ kind: "bar", labels: ["east", "west"], series: [{ name: "revenue", values: [100, 200] }] }} />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("aria-label");
    expect(html).toContain("revenue");
  });
});
```

`react-dom/server` is already a dependency of `platform` — no new package needed.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter platform test -- data-analysis data-chart`
Expected: FAIL.

- [ ] **Step 3: Implement DTOs**

`apps/platform/src/lib/data-analysis.ts`:

```ts
export type ChartSpec =
  | { kind: "bar"; labels: string[]; series: { name: string; values: number[] }[]; xLabel?: string; yLabel?: string }
  | { kind: "line"; labels: string[]; series: { name: string; values: number[] }[]; xLabel?: string; yLabel?: string }
  | { kind: "scatter"; points: { x: number; y: number }[]; xLabel?: string; yLabel?: string }
  | { kind: "histogram"; bins: { min: number; max: number; count: number }[]; label?: string };

export type TableDto = {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChartSpec(value: unknown): ChartSpec | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "bar":
    case "line": {
      const labels = Array.isArray(value.labels) ? value.labels.filter((l) => typeof l === "string") : [];
      const series = Array.isArray(value.series)
        ? value.series
            .filter((s): s is { name: string; values: number[] } =>
              isRecord(s) && typeof s.name === "string" && Array.isArray(s.values) && s.values.every((v) => typeof v === "number"),
            )
        : [];
      if (series.length === 0) return null;
      return { kind: value.kind, labels, series } as ChartSpec;
    }
    case "scatter": {
      const points = Array.isArray(value.points)
        ? value.points.filter((p): p is { x: number; y: number } => isRecord(p) && typeof p.x === "number" && typeof p.y === "number")
        : [];
      if (points.length === 0) return null;
      return { kind: "scatter", points } as ChartSpec;
    }
    case "histogram": {
      const bins = Array.isArray(value.bins)
        ? value.bins.filter((b): b is { min: number; max: number; count: number } => isRecord(b) && typeof b.min === "number" && typeof b.max === "number" && typeof b.count === "number")
        : [];
      if (bins.length === 0) return null;
      return { kind: "histogram", bins } as ChartSpec;
    }
    default:
      return null;
  }
}

export function parseTableDto(value: unknown): TableDto | null {
  if (!isRecord(value)) return null;
  const columns = Array.isArray(value.columns)
    ? value.columns.filter((c): c is { name: string; type: string } => isRecord(c) && typeof c.name === "string")
    : [];
  const rows = Array.isArray(value.rows)
    ? value.rows.filter((r): r is (string | number | boolean | null)[] => Array.isArray(r))
    : [];
  if (columns.length === 0) return null;
  return { columns, rows };
}
```

- [ ] **Step 4: Implement components**

`apps/platform/src/components/data/data-table.tsx`:

```tsx
import type { TableDto } from "#/lib/data-analysis";

const TYPE_BADGES: Record<string, string> = {
  number: "num",
  string: "str",
  boolean: "bool",
};

export function DataTable({
  columns,
  rows,
  rowCount,
  truncated,
}: TableDto & { rowCount?: number; truncated?: boolean }) {
  const shown = rowCount ?? rows.length;
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-white/[0.06]">
      <table className="w-full border-collapse text-[12px]" aria-label="Data table">
        <thead className="sticky top-0 bg-canvas-elevated">
          <tr>
            {columns.map((col) => (
              <th
                key={col.name}
                className="whitespace-nowrap border-b border-white/[0.06] px-2 py-1.5 text-left font-medium text-text"
              >
                {col.name}
                <span className="ml-1 text-[9px] uppercase text-text-faint">
                  {TYPE_BADGES[col.type] ?? col.type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="odd:bg-white/[0.015]">
              {columns.map((col, ci) => (
                <td key={col.name} className="border-b border-white/[0.04] px-2 py-1 text-text-muted">
                  {row[ci] === null ? "—" : String(row[ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="border-t border-white/[0.06] px-2 py-1 text-[10px] text-text-faint">
          Showing {rows.length} of {shown} rows
        </p>
      ) : null}
    </div>
  );
}
```

`apps/platform/src/components/data/data-chart.tsx`:

```tsx
import type { ChartSpec } from "#/lib/data-analysis";

const CHART_W = 320;
const CHART_H = 160;
const PAD = { top: 12, right: 12, bottom: 22, left: 36 };

export function DataChart({ spec }: { spec: ChartSpec }) {
  return (
    <div role="img" aria-label={describeSpec(spec)} className="w-full overflow-hidden rounded-lg border border-white/[0.06] p-2">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        aria-hidden="true"
      >
        {renderSpec(spec)}
      </svg>
    </div>
  );
}

function describeSpec(spec: ChartSpec): string {
  switch (spec.kind) {
    case "bar":
    case "line":
      return `${spec.kind} chart: ${spec.series.map((s) => `${s.name} (${s.values.join(", ")})`).join("; ")}`;
    case "scatter":
      return `scatter chart: ${spec.points.length} points`;
    case "histogram":
      return `histogram: ${spec.bins.map((b) => `${b.count}`).join(", ")}`;
  }
}

function scale(values: number[], max: number, height: number, base = 0) {
  const maxV = Math.max(base, ...values);
  return values.map((v) => (maxV === 0 ? 0 : (v / maxV) * height));
}

function renderSpec(spec: ChartSpec) {
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  switch (spec.kind) {
    case "bar": {
      const groupWidth = plotW / Math.max(1, spec.labels.length);
      const barWidth = Math.max(2, (groupWidth / spec.series.length) * 0.7);
      const seriesMax = Math.max(1, ...spec.series.flatMap((s) => s.values));
      return (
        <>
          {axes(spec.yLabel)}
          {spec.series.map((series) =>
            series.values.map((value, i) => {
              const h = (value / seriesMax) * plotH;
              const x = PAD.left + i * groupWidth + (spec.series.indexOf(series) + 0.15) * (groupWidth / spec.series.length);
              return <rect key={`${series.name}-${i}`} x={x} y={CHART_H - PAD.bottom - h} width={barWidth} height={h} rx={1} className="fill-accent/80" />;
            }),
          )}
          {spec.labels.map((label, i) => (
            <text key={`l-${i}`} x={PAD.left + i * groupWidth + groupWidth / 2} y={CHART_H - 8} textAnchor="middle" className="fill-text-faint" fontSize={8}>
              {short(label)}
            </text>
          ))}
        </>
      );
    }
    case "line": {
      const xMax = Math.max(1, spec.labels.length - 1);
      const seriesMax = Math.max(1, ...spec.series.flatMap((s) => s.values));
      return (
        <>
          {axes(spec.yLabel)}
          {spec.series.map((series) => {
            const points = series.values.map((value, i) => ({
              x: PAD.left + (i / xMax) * plotW,
              y: CHART_H - PAD.bottom - (value / seriesMax) * plotH,
            }));
            return (
              <polyline
                key={series.name}
                points={points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                strokeWidth={1.5}
                className="stroke-accent"
              />
            );
          })}
        </>
      );
    }
    case "scatter": {
      const xs = spec.points.map((p) => p.x);
      const ys = spec.points.map((p) => p.y);
      const xMax = Math.max(1, ...xs);
      const yMax = Math.max(1, ...ys);
      return (
        <>
          {axes(`${spec.yLabel ?? ""}`)}
          {spec.points.map((p, i) => (
            <circle
              key={i}
              cx={PAD.left + (p.x / xMax) * plotW}
              cy={CHART_H - PAD.bottom - (p.y / yMax) * plotH}
              r={2.5}
              className="fill-accent"
            />
          ))}
        </>
      );
    }
    case "histogram": {
      const maxCount = Math.max(1, ...spec.bins.map((b) => b.count));
      const binW = plotW / Math.max(1, spec.bins.length);
      return (
        <>
          {axes(spec.label)}
          {spec.bins.map((b, i) => {
            const h = (b.count / maxCount) * plotH;
            return (
              <rect
                key={i}
                x={PAD.left + i * binW + 1}
                y={CHART_H - PAD.bottom - h}
                width={Math.max(2, binW - 2)}
                height={h}
                rx={1}
                className="fill-accent/80"
              />
            );
          })}
        </>
      );
    }
  }
}

function axes(yLabel?: string) {
  return (
    <>
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={CHART_H - PAD.bottom} className="stroke-white/10" strokeWidth={1} />
      <line x1={PAD.left} y1={CHART_H - PAD.bottom} x2={CHART_W - PAD.right} y2={CHART_H - PAD.bottom} className="stroke-white/10" strokeWidth={1} />
      {yLabel ? (
        <text x={8} y={CHART_H / 2} textAnchor="middle" transform={`rotate(-90 8 ${CHART_H / 2})`} className="fill-text-faint" fontSize={8}>
          {yLabel}
        </text>
      ) : null}
    </>
  );
}

function short(value: string): string {
  return value.length > 10 ? `${value.slice(0, 9)}…` : value;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter platform test -- data-analysis data-chart`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/platform/src/lib/data-analysis.ts apps/platform/src/lib/data-analysis.test.ts apps/platform/src/components/data
git commit -m "feat(platform): data DTOs + DataTable + DataChart (SVG) components"
```

---

### Task 9: Frontend — render tables/charts in tool results

**Files:**
- Modify: `apps/platform/src/components/tool-io-format.ts`
- Modify: `apps/platform/src/components/tool-activity-panel.tsx`
- Test: `apps/platform/src/components/tool-io-format.test.ts` (if the file has no test yet, create one)

**Interfaces:**
- Consumes: `parseChartSpec`, `parseTableDto` (Task 8)
- Produces: `FormattedSection` gains `chart?: unknown` and `table?: unknown` (raw payloads, validated by the panel)

- [ ] **Step 1: Extend `FormattedSection` + add formatters**

In `apps/platform/src/components/tool-io-format.ts`:

```ts
export type FormattedSection = {
  title: string;
  summary?: string;
  fields?: FormattedField[];
  items?: FormattedItem[];
  emptyText?: string;
  imageLoading?: boolean;
  /** Raw chart spec payload (validated by the panel via parseChartSpec). */
  chart?: unknown;
  /** Raw table payload (validated by the panel via parseTableDto). */
  table?: unknown;
};
```

Add formatters (append near the other tool formatters, before `formatToolInput`):

```ts
function formatReadDatasetOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const columns = asArray(record.columns).filter((c) => isRecord(c) && typeof c.name === "string");
  const preview = asArray(record.preview);
  return {
    title: "Result",
    summary: `Dataset: ${asString(record.name) ?? "—"} · ${String(record.rowCount ?? 0)} rows`,
    fields: columns.slice(0, 8).map((c) => ({
      label: (c as { name: string }).name,
      value: String((c as { type?: unknown }).type ?? ""),
    })),
    table: isRecord(record) ? { columns, rows: preview, rowCount: record.rowCount, truncated: false } : undefined,
  };
}

function formatAnalyzeDatasetOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  return {
    title: "Result",
    summary: asString(record.summary) ?? "Analysis",
    ...(isRecord(record.result) ? { table: record.result } : {}),
    ...(isRecord(record.chart) ? { chart: record.chart } : {}),
  };
}

function formatQueryDatasetSqlOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  return {
    title: "Result",
    summary: `${String(record.rowCount ?? 0)} row${Number(record.rowCount) === 1 ? "" : "s"}`,
    table: record,
  };
}

function formatExtractDocumentTablesOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const tables = asArray(record.tables);
  return {
    title: "Result",
    summary: `${tables.length} table${tables.length === 1 ? "" : "s"} found`,
    items: tables.slice(0, 10).map((t) => {
      const rec = isRecord(t) ? t : {};
      const filename = asString(rec.filename) ?? "";
      const cols = asArray(rec.columns).filter((c) => isRecord(c) && typeof c.name === "string");
      return {
        title: `${filename} · page ${Number(rec.pageIndex) + 1} · table ${Number(rec.tableIndex) + 1}`,
        meta: `${cols.length} columns · ${String(rec.rowCount ?? 0)} rows`,
      };
    }),
  };
}
```

Register them in the `formatToolOutput` switch:

```ts
case "read_dataset": return formatReadDatasetOutput(output);
case "analyze_dataset": return formatAnalyzeDatasetOutput(output);
case "query_dataset_sql": return formatQueryDatasetSqlOutput(output);
case "extract_document_tables": return formatExtractDocumentTablesOutput(output);
```

- [ ] **Step 2: Write a test for the formatters**

`apps/platform/src/components/tool-io-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
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
  });
});
```

- [ ] **Step 3: Render chart/table in `ToolActivityPanel`**

In `apps/platform/src/components/tool-activity-panel.tsx`, add imports and a renderer:

```tsx
import { DataChart } from "#/components/data/data-chart";
import { DataTable } from "#/components/data/data-table";
import { parseChartSpec, parseTableDto } from "#/lib/data-analysis";
```

Inside `ToolSectionView`, after the fields/items and before `imageLoading`:

```tsx
{section.chart !== undefined ? <ChartFromSection chart={section.chart} /> : null}
{section.table !== undefined ? <TableFromSection table={section.table} /> : null}
```

```tsx
function ChartFromSection({ chart }: { chart: unknown }) {
  const spec = parseChartSpec(chart);
  return spec ? <DataChart spec={spec} /> : null;
}

function TableFromSection({ table }: { table: unknown }) {
  const parsed = parseTableDto(table);
  if (!parsed) return null;
  return (
    <DataTable
      columns={parsed.columns}
      rows={parsed.rows.slice(0, 20)}
      rowCount={typeof (table as { rowCount?: unknown }).rowCount === "number" ? (table as { rowCount: number }).rowCount : parsed.rows.length}
      truncated={Boolean((table as { truncated?: unknown }).truncated)}
    />
  );
}
```

- [ ] **Step 4: Add labels for the new tools**

In the `TOOL_LABELS` map:

```ts
read_dataset: "Reading dataset",
analyze_dataset: "Analyzing data",
query_dataset_sql: "Querying data (SQL)",
extract_document_tables: "Extracting tables",
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter platform test -- tool-io-format tool-activity-panel`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/platform/src/components/tool-io-format.ts apps/platform/src/components/tool-io-format.test.ts apps/platform/src/components/tool-activity-panel.tsx
git commit -m "feat(platform): render DataChart/DataTable inside tool-result cards"
```

---

### Task 10: Frontend — upload accept, toggle, and body flag

**Files:**
- Modify: `apps/platform/src/components/composer/composer-attach-control.tsx`
- Modify: `apps/platform/src/lib/documents/upload-file.ts`
- Modify: `apps/platform/src/components/composer/features-popover.tsx`
- Modify: `apps/platform/src/components/composer/chat-composer.tsx`
- Modify: `apps/platform/src/routes/index.tsx`

**Interfaces:**
- Produces: `dataAnalysisEnabled` per-session state, sent in `POST /api/chat` body; upload accepts `.csv,.xlsx`; features popover shows a presentational "Data analysis" switch.

- [ ] **Step 1: Upload accept + MIME map**

In `composer-attach-control.tsx` accept string add `.csv,.xlsx`. In `apps/platform/src/lib/documents/upload-file.ts`, extend the extension→MIME map:

```ts
".csv": "text/csv",
".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
```

- [ ] **Step 2: Features popover — "Data analysis" switch**

In `features-popover.tsx`, add props `dataAnalysisEnabled: boolean; onDataAnalysisToggle: (enabled: boolean) => void; dataAnalysisAvailable: boolean` (availability = true; reserved for a future sandbox gate). Render a switch row mirroring the Web search row (icon: `BarChart3` from lucide). Wire into `anyAvailable`/`anyEnabled` so the plus button and active-icon segment include it.

- [ ] **Step 3: Chat composer + route state**

- `chat-composer.tsx`: thread `dataAnalysisEnabled`/`onDataAnalysisToggle` props through to `FeaturesPopover` (mirror `webSearchEnabled`, lines ~57-63/108-118/390-396).
- `routes/index.tsx`: add `const [dataAnalysisEnabled, setDataAnalysisEnabled] = useState(false)`, a ref (mirror `webSearchEnabledRef`), include `dataAnalysisEnabled: dataAnalysisEnabledRef.current` in the `useChat` body (around `:1396-1398`), and pass state+setter to `ChatComposer` (around `:3080-3088`).
- The API already ignores unknown body fields; no router change needed in v1 (toggle is presentational).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter platform exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/composer apps/platform/src/lib/documents/upload-file.ts apps/platform/src/routes/index.tsx
git commit -m "feat(platform): CSV/XLSX upload accept + Data analysis feature switch"
```

---

### Task 11: Fixtures + real-LLM E2E (Plan 1 cases 1-8)

**Files:**
- Create: `apps/platform/e2e/fixtures/sales.csv`
- Create: `apps/platform/e2e/fixtures/multi-sheet.xlsx`
- Create: `apps/platform/e2e/fixtures/table-rich.pdf`
- Create: `apps/platform/e2e/data-analysis.real-llm.e2e.ts`

**Interfaces:**
- Consumes: helpers from `real-llm.e2e.ts` pattern (`openFreshChat`, `sendMessage`, `waitForStreaming`, `waitForRunDone`, `openFeaturesPopover`, `setSwitch` — copy or extract into `e2e/helpers.ts`).

- [ ] **Step 1: Fixtures**

- `sales.csv` (~40 rows): `region,product,revenue,units\nEast,Alpha,1200,10\n…` (deterministic, simple).
- `multi-sheet.xlsx`: two sheets (`Summary`, `Detail`) with a numeric + string column each (generate with Excel/LibreOffice or a tiny script using `xlsx`; commit the binary).
- `table-rich.pdf`: a small PDF containing 1-2 GFM-style tables (generate from HTML/markdown via a tool; commit).

- [ ] **Step 2: Write the real-LLM E2E spec (cases 1-8)**

`apps/platform/e2e/data-analysis.real-llm.e2e.ts` — headed, real LLM, no stub:

```ts
import { expect, test, type Page } from "@playwright/test";
import { openFreshChat, sendMessage, waitForRunDone, waitForStreaming } from "./helpers";

async function uploadFile(page: Page, file: string): Promise<void> {
  await page.getByRole("button", { name: /attach|add file/i }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByText(/attach|upload/i).first().click();
  const fc = await chooser;
  await fc.setFiles(`e2e/fixtures/${file}`);
  await expect(page.locator("[data-uploading-documents-section]")).toBeVisible();
  await expect(page.locator("[data-uploading-documents-section]")).toHaveText(/.+/, { timeout: 120_000 });
  // wait for ingest ready pill (document becomes "ready" in the rail)
  await expect(page.getByText(new RegExp(file))).toBeVisible({ timeout: 120_000 });
}

test("P1-C1: CSV upload -> read_dataset preview renders a DataTable", async ({ page }) => {
  await openFreshChat(page);
  await uploadFile(page, "sales.csv");
  await sendMessage(page, "What columns does my sales data have and how many rows?");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator('[aria-label="Data table"]').last()).toBeVisible();
});

test("P1-C2: aggregate + bar chart", async ({ page }) => {
  await openFreshChat(page);
  await uploadFile(page, "sales.csv");
  await sendMessage(page, "Give me the average revenue per region in a table and a bar chart.");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator('[aria-label="Data table"]').last()).toBeVisible();
  await expect(page.locator('[role="img"][aria-label*="bar chart"]').last()).toBeVisible();
});

test("P1-C3: correlation + scatter chart", async ({ page }) => {
  await openFreshChat(page);
  await uploadFile(page, "sales.csv");
  await sendMessage(page, "Correlate price and units sold and show a scatter chart.");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator('[role="img"][aria-label*="scatter"]').last()).toBeVisible();
});

test("P1-C4: SQL query returns a table", async ({ page }) => {
  await openFreshChat(page);
  await uploadFile(page, "sales.csv");
  await sendMessage(page, "Top 3 products by total revenue using SQL.");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator('[aria-label="Data table"]').last()).toBeVisible();
});

test("P1-C5: XLSX multi-sheet", async ({ page }) => {
  await openFreshChat(page);
  await uploadFile(page, "multi-sheet.xlsx");
  await sendMessage(page, "Read the Detail sheet and show its columns.");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator('[aria-label="Data table"]').last()).toBeVisible();
});

test("P1-C6: PDF table extraction", async ({ page }) => {
  await openFreshChat(page);
  await uploadFile(page, "table-rich.pdf");
  await sendMessage(page, "Extract the tables from my document and analyze the first one.");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator('[aria-label="Data table"]').last()).toBeVisible();
});

test("P1-C7: no tabular source -> answers without analysis tools", async ({ page }) => {
  await openFreshChat(page);
  await sendMessage(page, "Analyze the numbers: what is 12 + 7?");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator("article").last()).toContainText(/19/);
});

test("P1-C8: chart/table renders mid-chat between user message and assistant text", async ({ page }) => {
  await openFreshChat(page);
  await uploadFile(page, "sales.csv");
  await sendMessage(page, "Average revenue per region, please.");
  await waitForRunDone(page);
  const chart = page.locator('[role="img"][aria-label*="bar chart"]').last();
  await expect(chart).toBeVisible();
  const userMsg = page.locator("article").first();
  const assistant = page.locator("article").last();
  const chartBox = await chart.boundingBox();
  const userBox = await userMsg.boundingBox();
  const asstBox = await assistant.boundingBox();
  expect(chartBox!.y).toBeGreaterThan(userBox!.y);
  expect(chartBox!.y).toBeLessThan(asstBox!.y! + asstBox!.height!);
});
```

If helpers are not extracted, inline the helper functions from `real-llm.e2e.ts` (copy `openFreshChat`, `sendMessage`, `waitForStreaming`, `waitForRunDone`).

- [ ] **Step 3: Run the suite (real LLM, headed)**

Prereq: `PORT=3001 BETTER_AUTH_URL=http://localhost:3001 pnpm dev` with real `.env` (OpenRouter), Docker/Postgres up, DB migrated. Then:

Run: `pnpm --filter platform exec -- playwright test --config playwright.real-llm.config.ts`
Expected: cases P1-C1..C8 pass (some cases may need a model switch to `openai/gpt-5.6-luna` or `deepseek/deepseek-v4-flash` via the UI to hit the SQL/tool path reliably).

- [ ] **Step 4: Commit**

```bash
git add apps/platform/e2e/fixtures apps/platform/e2e/data-analysis.real-llm.e2e.ts
git commit -m "test(e2e): real-LLM tabular data analysis cases (P1-C1..C8)"
```

---

### Task 12: Behavior evals for tool choice

**Files:**
- Modify: `packages/agent/src/evals/` (add a `tabular-analysis` suite: `suites/tabular-analysis.ts` + register in `run.ts`)
- Modify: `packages/agent/README.md` (suite table)

**Interfaces:**
- Consumes: existing eval harness (`packages/agent/README.md` describes `BehaviorExpectation`, suites, `EVAL_MODEL` etc.)

- [ ] **Step 1: Add the suite**

Mirror an existing suite (e.g. `tool-choice`) with stub backends. Cases:
1. "average revenue by region" with an uploaded CSV in context → `expected.requiredTools: ["analyze_dataset"]` (not SQL).
2. "top 3 products by total revenue, use whatever query you need" → `requiredTools: ["query_dataset_sql"]`.
3. Document containing a table → `requiredTools: ["extract_document_tables"]` then `analyze_dataset`.
4. Plain math question, no data source → no tabular tool required (and no crash).

Follow the exact suite shape from `packages/agent/src/evals/` (register in `run.ts`, declare `EVAL_MODEL` default).

- [ ] **Step 2: Run the suite**

Run: `pnpm --filter agent evals --suite tabular-analysis`
Expected: all cases pass (real `EVAL_MODEL`, e.g. `deepseek/deepseek-v4-flash-0731`).

- [ ] **Step 3: Update README suite table**

Add row: `tabular-analysis | read/analyze/sql tool choice, extract_document_tables, abstain without data`.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/evals packages/agent/README.md
git commit -m "test(evals): tabular-analysis tool-choice suite"
```

---

### Task 13: Hands-on MCP Playwright verification (Plan 1, real browser)

**Files:**
- Evidence under `.playwright-mcp/` (screenshots + console logs + page snapshots)

- [ ] **Step 1: Boot the real stack**

Ensure `pnpm dev` on `:3000`/`:3001` with real `.env` (OpenRouter + Tavily + R2 as needed), Docker up, DB migrated. Confirm `http://localhost:3000` loads and login works.

- [ ] **Step 2: Drive each Plan 1 case in the real headed browser**

Using the **MCP Playwright** tools (`browser_navigate` → real login → `browser_file_upload` to attach fixtures through the actual file chooser → `browser_type` the question → wait for the run → `browser_snapshot` + `browser_take_screenshot`), verify cases P1-C1..C8 and save evidence:
- Browser opened at `http://localhost:3000` (headed, visible).
- Per case: one accessibility snapshot + one screenshot saved under `.playwright-mcp/data-analysis/`.
- Assert mid-chat placement (chart between user message and assistant text).

- [ ] **Step 3: Record evidence + result**

Console messages checked for errors (`browser_console_messages`, level error). Screenshots saved as `.playwright-mcp/data-analysis/<case>.png`.

- [ ] **Step 4: Commit evidence summary**

```bash
git add .playwright-mcp/data-analysis
git commit -m "test(e2e): hands-on MCP Playwright verification of Plan 1 cases (real browser)"
```
