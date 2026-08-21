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
          summary: `${operation.column}: count=${values.length}, mean=${mean.toFixed(2)}, min=${min}, max=${max}, q1=${q(0.25).toFixed(2)}, median=${q(0.5).toFixed(2)}, q3=${q(0.75).toFixed(2)}`,
          chart: { kind: "histogram", bins, label: operation.column },
        };
      }
      return { operation: "profile", summary: `profile of all columns (n=${sheet.rows.length})`, result: table(sheet.columns, sheet.rows.slice(0, 10), limits) };
    }
  }
}
