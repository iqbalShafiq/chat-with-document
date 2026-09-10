import { mean as seriesMean, mode as seriesMode, pearsonCorrelation, quantileSorted, sampleStdDev, sampleVariance } from "../data-analysis.js";
import type { CellValue, ColumnType, TabularColumn, TabularSheet } from "./types.js";
import type { ChartSpec } from "./chart-spec.js";

export type AnalysisOperation =
  | { op: "profile"; column?: string }
  | {
      op: "aggregate";
      groupBy: string[];
      metrics: { column: string; fn: "sum" | "mean" | "count" | "min" | "max" | "median" | "count_distinct" | "stddev" }[];
    }
  | { op: "filter"; column: string; predicate: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains"; value: CellValue }
  | { op: "sort"; column: string; order: "asc" | "desc" }
  | { op: "top_n"; column: string; n: number; groupBy?: string[]; metric?: "sum" | "mean" | "count" | "min" | "max" | "median" }
  | { op: "correlation"; x: string; y: string }
  | { op: "trend"; x: string; y: string }
  | { op: "stats"; column: string }
  | { op: "regression"; x: string; y: string; predictFor?: number[] }
  | { op: "correlation_matrix"; columns?: string[] }
  | { op: "multiple_regression"; y: string; xs: string[] }
  | { op: "ttest"; column: string; groupBy: string; groupA: string; groupB: string }
  | { op: "anova"; column: string; groupBy: string }
  | { op: "outliers"; column: string; method?: "iqr" | "zscore"; threshold?: number }
  | { op: "crosstab"; x: string; y: string; metric?: "count" | "sum" | "mean"; valueColumn?: string };

export type AnalysisResult = {
  operation: string;
  summary: string;
  result?: { columns: TabularColumn[]; rows: CellValue[][]; rowCount: number; truncated: boolean } | undefined;
  chart?: ChartSpec | undefined;
};

const DEFAULT_LIMITS = { maxRows: 500 };

function columnIndex(sheet: TabularSheet, name: string): number {
  const index = sheet.columns.findIndex((c) => c.name === name);
  if (index < 0) {
    const available = sheet.columns.map((c) => `"${c.name}"`).join(", ") || "(no columns)";
    throw new Error(`Unknown column: "${name}". Available columns: ${available}.`);
  }
  return index;
}

function numericValues(sheet: TabularSheet, name: string): number[] {
  const index = columnIndex(sheet, name);
  return sheet.rows
    .map((row) => row[index])
    .filter((v): v is number => typeof v === "number");
}

function pairedNumericValues(sheet: TabularSheet, x: string, y: string): { x: number[]; y: number[] } {
  const xi = columnIndex(sheet, x);
  const yi = columnIndex(sheet, y);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const row of sheet.rows) {
    const xv = row[xi];
    const yv = row[yi];
    if (typeof xv === "number" && typeof yv === "number") {
      xs.push(xv);
      ys.push(yv);
    }
  }
  return { x: xs, y: ys };
}

export function describeNumericColumn(column: string, values: number[]): Record<string, number | number[] | null> {
  const sorted = [...values].sort((a, b) => a - b);
  const avg = seriesMean(values);
  const variance = sampleVariance(values, avg);
  const stdDev = Math.sqrt(variance);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  let skewness: number | null = null;
  if (values.length >= 3 && stdDev > 0) {
    const n = values.length;
    const m3 = values.reduce((sum, value) => sum + (value - avg) ** 3, 0) / n;
    skewness = (Math.sqrt(n * (n - 1)) / (n - 2)) * (m3 / stdDev ** 3);
  }
  return {
    count: values.length,
    mean: avg,
    median: quantileSorted(sorted, 0.5),
    mode: seriesMode(values),
    min,
    max,
    range: max - min,
    q1,
    q3,
    iqr: q3 - q1,
    variance,
    stdDev,
    skewness,
  };
}

export function fitLinearRegression(x: number[], y: number[], predictFor: number[] = []): {
  n: number;
  equation: string;
  slope: number;
  intercept: number;
  rSquared: number;
  residualStdDev: number;
  residualMean: number;
  predictions: { x: number; yHat: number }[];
} {
  if (x.length !== y.length) {
    throw new Error(`Series must have the same length (got ${x.length} and ${y.length})`);
  }
  if (x.length < 2) {
    throw new Error("Linear regression requires at least 2 observations");
  }
  const meanX = seriesMean(x);
  const meanY = seriesMean(y);
  let ssxx = 0;
  let ssxy = 0;
  let ssyy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    ssxx += dx * dx;
    ssxy += dx * dy;
    ssyy += dy * dy;
  }
  if (ssxx === 0) {
    throw new Error("Cannot fit regression when all x values are identical");
  }
  const slope = ssxy / ssxx;
  const intercept = meanY - slope * meanX;
  const rSquared = ssyy === 0 ? 1 : (ssxy * ssxy) / (ssxx * ssyy);
  const residuals = y.map((value, index) => value - (slope * x[index]! + intercept));
  return {
    n: x.length,
    equation: `y = ${slope} * x + ${intercept}`,
    slope,
    intercept,
    rSquared,
    residualStdDev: sampleStdDev(residuals),
    residualMean: seriesMean(residuals),
    predictions: predictFor.map((value) => ({ x: value, yHat: slope * value + intercept })),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const approx = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-(z * z) / 2) * poly;
  return z >= 0 ? approx : 1 - approx;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITER = 200;
  const EPS = 3e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  if (x < (a + 1) / (a + b + 2)) {
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta) / a;
    return front * betaContinuedFraction(a, b, x);
  }
  const front = Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBeta) / b;
  return 1 - front * betaContinuedFraction(b, a, 1 - x);
}

function lgamma(z: number): number {
  const coeff = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let x = coeff[0]!;
  for (let i = 1; i < 9; i++) {
    x += coeff[i]! / (z + i);
  }
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function tCdf(t: number, df: number): number {
  if (df <= 0) throw new Error("Degrees of freedom must be positive");
  if (t === 0) return 0.5;
  const x = df / (df + t * t);
  const ib = regularizedBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

function fCdf(f: number, d1: number, d2: number): number {
  if (f <= 0) return 0;
  const x = (d1 * f) / (d1 * f + d2);
  return regularizedBeta(x, d1 / 2, d2 / 2);
}

function solveLinearSystem(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) {
      throw new Error("Predictors are collinear; cannot fit multiple regression");
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const divisor = m[col]![col]!;
    for (let j = col; j <= n; j++) m[col]![j]! /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row]![col]!;
      for (let j = col; j <= n; j++) m[row]![j]! -= factor * m[col]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

export function welchTTest(a: number[], b: number[]): {
  n1: number;
  n2: number;
  mean1: number;
  mean2: number;
  difference: number;
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
} {
  if (a.length < 2 || b.length < 2) {
    throw new Error("t-test needs at least 2 observations per group");
  }
  const mean1 = seriesMean(a);
  const mean2 = seriesMean(b);
  const v1 = sampleVariance(a, mean1);
  const v2 = sampleVariance(b, mean2);
  const se = Math.sqrt(v1 / a.length + v2 / b.length);
  if (!(se > 0)) throw new Error("t-test is undefined when both groups have zero variance");
  const t = (mean1 - mean2) / se;
  const df =
    (v1 / a.length + v2 / b.length) ** 2 /
    ((v1 / a.length) ** 2 / (a.length - 1) + (v2 / b.length) ** 2 / (b.length - 1));
  return {
    n1: a.length,
    n2: b.length,
    mean1,
    mean2,
    difference: mean1 - mean2,
    tStatistic: t,
    degreesOfFreedom: df,
    pValue: 2 * (1 - tCdf(Math.abs(t), df)),
  };
}

export function oneWayAnova(groups: { name: string; values: number[] }[]): {
  groups: number;
  totalN: number;
  fStatistic: number;
  dfBetween: number;
  dfWithin: number;
  pValue: number;
} {
  const usable = groups.filter((g) => g.values.length > 0);
  if (usable.length < 2) throw new Error("ANOVA needs at least 2 non-empty groups");
  const all = usable.flatMap((g) => g.values);
  const grandMean = seriesMean(all);
  let ssBetween = 0;
  let ssWithin = 0;
  for (const group of usable) {
    const gm = seriesMean(group.values);
    ssBetween += group.values.length * (gm - grandMean) ** 2;
    ssWithin += group.values.reduce((sum, v) => sum + (v - gm) ** 2, 0);
  }
  const dfBetween = usable.length - 1;
  const dfWithin = all.length - usable.length;
  if (dfWithin <= 0) throw new Error("ANOVA needs more observations than groups");
  if (ssWithin === 0) {
    return { groups: usable.length, totalN: all.length, fStatistic: Number.POSITIVE_INFINITY, dfBetween, dfWithin, pValue: 0 };
  }
  const f = (ssBetween / dfBetween) / (ssWithin / dfWithin);
  return { groups: usable.length, totalN: all.length, fStatistic: f, dfBetween, dfWithin, pValue: 1 - fCdf(f, dfBetween, dfWithin) };
}

export function multipleRegression(y: number[], xs: number[][], featureNames: string[]): {
  n: number;
  intercept: number;
  coefficients: { name: string; value: number }[];
  rSquared: number;
  adjustedRSquared: number;
} {
  if (xs.length === 0) throw new Error("Multiple regression needs at least one predictor");
  const n = y.length;
  if (xs.some((col) => col.length !== n)) throw new Error("Predictors must match the response length");
  if (n <= xs.length) throw new Error("Multiple regression needs more observations than predictors");
  const design = y.map((_, i) => [1, ...xs.map((col) => col[i]!)]);
  const p = xs.length;
  const xtx = design[0]!.map((_, j) => design[0]!.map((__, k) => design.reduce((sum, row) => sum + row[j]! * row[k]!, 0)));
  const xty = design[0]!.map((_, j) => design.reduce((sum, row, i) => sum + row[j]! * y[i]!, 0));
  const beta = solveLinearSystem(xtx, xty);
  const yHat = design.map((row) => row.reduce((sum, v, j) => sum + v * beta[j]!, 0));
  const meanY = seriesMean(y);
  const ssTot = y.reduce((sum, v) => sum + (v - meanY) ** 2, 0);
  const ssRes = y.reduce((sum, v, i) => sum + (v - yHat[i]!) ** 2, 0);
  const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return {
    n,
    intercept: beta[0]!,
    coefficients: featureNames.map((name, i) => ({ name, value: beta[i + 1]! })),
    rSquared,
    adjustedRSquared: 1 - ((1 - rSquared) * (n - 1)) / (n - p - 1),
  };
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
          else if (m.fn === "count_distinct") metricCells.push(new Set(bucket.map((row) => JSON.stringify(row[index] ?? null))).size);
          else if (m.fn === "stddev") metricCells.push(values.length >= 2 ? sampleStdDev(values) : null);
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
      const chart: ChartSpec | undefined =
        outRows.length > 0 && operation.metrics.length > 0
          ? {
              kind: "bar",
              labels: outRows.map((row) => String(row[0] ?? "")),
              series: operation.metrics.map((metric, mi) => ({
                name: `${metric.fn}(${metric.column})`,
                values: outRows.map((row) => {
                  const v = row[groupIndexes.length + mi]!;
                  return typeof v === "number" ? v : 0;
                }),
              })),
              ...(operation.metrics.length === 1 ? { yLabel: operation.metrics[0]!.column } : {}),
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
      const { x, y } = pairedNumericValues(sheet, operation.x, operation.y);
      if (x.length < 2) {
        return { operation: "correlation", summary: `Not enough paired numeric data in "${operation.x}" and "${operation.y}"` };
      }
      const r = pearsonCorrelation(x, y);
      return {
        operation: "correlation",
        summary: `r = ${r.toFixed(4)} (${r >= 0 ? "positive" : "negative"}, ${Math.abs(r) >= 0.7 ? "strong" : Math.abs(r) >= 0.4 ? "moderate" : "weak"})`,
        chart: { kind: "scatter", points: x.map((xi, i) => ({ x: xi, y: y[i]! })), xLabel: operation.x, yLabel: operation.y },
      };
    }
    case "stats": {
      const values = numericValues(sheet, operation.column);
      if (values.length === 0) {
        return { operation: "stats", summary: `No usable data in column "${operation.column}" (all values non-numeric or empty)` };
      }
      const stats = describeNumericColumn(operation.column, values);
      const entries = Object.entries(stats).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`);
      return {
        operation: "stats",
        summary: `${operation.column}: ${entries.join(", ")}`,
      };
    }
    case "regression": {
      const { x, y } = pairedNumericValues(sheet, operation.x, operation.y);
      if (x.length < 2) {
        return { operation: "regression", summary: `Not enough paired numeric data in "${operation.x}" and "${operation.y}"` };
      }
      const fit = fitLinearRegression(x, y, operation.predictFor ?? []);
      const sorted = x.map((xi, i) => ({ x: xi, y: y[i]! })).sort((a, b) => a.x - b.x);
      return {
        operation: "regression",
        summary: `${fit.equation} · R² = ${fit.rSquared.toFixed(4)} (n=${fit.n})`,
        chart: {
          kind: "scatter",
          points: sorted,
          xLabel: operation.x,
          yLabel: operation.y,
        },
      };
    }
    case "correlation_matrix": {
      const requested = operation.columns ?? sheet.columns.map((c) => c.name);
      const numericColumns = requested
        .filter((name) => sheet.columns.some((c) => c.name === name))
        .filter((name) => numericValues(sheet, name).length >= 2);
      if (numericColumns.length < 2) {
        throw new Error(`correlation_matrix needs at least 2 numeric columns. Available columns: ${sheet.columns.map((c) => `"${c.name}"`).join(", ")}.`);
      }
      if (numericColumns.length > 20) {
        throw new Error(`Too many numeric columns (${numericColumns.length} > 20). Pass columns to narrow it down.`);
      }
      const cell = (a: string, b: string): CellValue => {
        if (a === b) return 1;
        const { x, y } = pairedNumericValues(sheet, a, b);
        if (x.length < 2) return null;
        try {
          return Math.round(pearsonCorrelation(x, y) * 10000) / 10000;
        } catch {
          return null;
        }
      };
      return {
        operation: "correlation_matrix",
        summary: `correlation matrix over ${numericColumns.length} columns`,
        result: table(
          [{ name: "column", type: "string" }, ...numericColumns.map((name) => ({ name, type: "number" as const }))],
          numericColumns.map((a) => [a, ...numericColumns.map((b) => cell(a, b))]),
          limits,
        ),
      };
    }
    case "multiple_regression": {
      const yIndex = columnIndex(sheet, operation.y);
      const xIndexes = operation.xs.map((name) => columnIndex(sheet, name));
      const y: number[] = [];
      const xs: number[][] = xIndexes.map(() => []);
      for (const row of sheet.rows) {
        const yv = row[yIndex];
        const xv = xIndexes.map((i) => row[i]);
        if (typeof yv === "number" && xv.every((v): v is number => typeof v === "number")) {
          y.push(yv);
          xv.forEach((v, j) => xs[j]!.push(v));
        }
      }
      if (y.length <= operation.xs.length) {
        return { operation: "multiple_regression", summary: `Not enough complete rows in "${operation.y}" and [${operation.xs.join(", ")}] (need more rows than predictors)` };
      }
      const fit = multipleRegression(y, xs, operation.xs);
      const terms = [`intercept=${fit.intercept.toFixed(4)}`, ...fit.coefficients.map((c) => `${c.name}=${c.value.toFixed(4)}`)];
      return {
        operation: "multiple_regression",
        summary: `${operation.y} = ${terms.join(" + ")} · R² = ${fit.rSquared.toFixed(4)}, adjusted R² = ${fit.adjustedRSquared.toFixed(4)} (n=${fit.n})`,
      };
    }
    case "ttest": {
      const groupIndex = columnIndex(sheet, operation.groupBy);
      const valueIndex = columnIndex(sheet, operation.column);
      const collect = (label: string): number[] =>
        sheet.rows
          .filter((row) => String(row[groupIndex] ?? "") === label)
          .map((row) => row[valueIndex])
          .filter((v): v is number => typeof v === "number");
      const a = collect(operation.groupA);
      const b = collect(operation.groupB);
      if (a.length < 2 || b.length < 2) {
        return { operation: "ttest", summary: `Not enough data: "${operation.groupA}" has ${a.length} values, "${operation.groupB}" has ${b.length} values (need ≥ 2 each)` };
      }
      const result = welchTTest(a, b);
      const significant = result.pValue < 0.05 ? "significant at α=0.05" : "not significant at α=0.05";
      return {
        operation: "ttest",
        summary: `${operation.column}: ${operation.groupA} (mean=${result.mean1.toFixed(2)}, n=${result.n1}) vs ${operation.groupB} (mean=${result.mean2.toFixed(2)}, n=${result.n2}): t=${result.tStatistic.toFixed(3)}, df=${result.degreesOfFreedom.toFixed(1)}, p=${result.pValue.toFixed(4)} (${significant})`,
      };
    }
    case "anova": {
      const groupIndex = columnIndex(sheet, operation.groupBy);
      const valueIndex = columnIndex(sheet, operation.column);
      const buckets = new Map<string, number[]>();
      for (const row of sheet.rows) {
        const label = String(row[groupIndex] ?? "(empty)");
        const v = row[valueIndex];
        if (typeof v !== "number") continue;
        const bucket = buckets.get(label) ?? [];
        bucket.push(v);
        buckets.set(label, bucket);
      }
      const groups = [...buckets.entries()].map(([name, values]) => ({ name, values }));
      if (groups.length < 2) {
        return { operation: "anova", summary: `Not enough groups in "${operation.groupBy}" for ANOVA` };
      }
      const result = oneWayAnova(groups);
      const significant = result.pValue < 0.05 ? "significant at α=0.05" : "not significant at α=0.05";
      return {
        operation: "anova",
        summary: `${operation.column} across ${result.groups} groups of "${operation.groupBy}" (n=${result.totalN}): F=${Number.isFinite(result.fStatistic) ? result.fStatistic.toFixed(3) : "∞"}, df=(${result.dfBetween}, ${result.dfWithin}), p=${result.pValue.toFixed(4)} (${significant})`,
      };
    }
    case "trend": {
      const xi = columnIndex(sheet, operation.x);
      const yi = columnIndex(sheet, operation.y);
      const numericPoints = sheet.rows
        .map((row) => ({ x: row[xi], y: row[yi] }))
        .filter((p): p is { x: number; y: number } => typeof p.x === "number" && typeof p.y === "number")
        .sort((a, b) => a.x - b.x);
      const datePoints = sheet.rows
        .map((row) => ({ x: row[xi], y: row[yi] }))
        .filter((p): p is { x: string; y: number } => typeof p.x === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(p.x) && typeof p.y === "number")
        .sort((a, b) => a.x.localeCompare(b.x));
      const points = numericPoints.length > 0 ? numericPoints.map((p) => ({ x: p.x as number | string, y: p.y })) : datePoints;
      if (points.length === 0) {
        return { operation: "trend", summary: `No usable trend data: "${operation.x}" must be numeric or ISO dates and "${operation.y}" numeric` };
      }
      return {
        operation: "trend",
        summary: `${points.length} points sorted by ${operation.x}`,
        chart: { kind: "line", labels: points.map((p) => String(p.x)), series: [{ name: operation.y, values: points.map((p) => p.y) }], xLabel: operation.x, yLabel: operation.y },
      };
    }
    case "top_n": {
      if (operation.groupBy && operation.groupBy.length > 0) {
        const metric = operation.metric ?? "sum";
        const grouped = runAnalysis(sheet, {
          op: "aggregate",
          groupBy: operation.groupBy,
          metrics: [{ column: operation.column, fn: metric === "median" ? "median" : metric }],
        }, limits);
        if (!grouped.result) {
          return { operation: "top_n", summary: `Could not group by ${operation.groupBy.join(", ")}` };
        }
        const valueIndex = operation.groupBy.length;
        const ranked = [...grouped.result.rows]
          .map((row) => ({ row, value: typeof row[valueIndex] === "number" ? (row[valueIndex] as number) : Number.NEGATIVE_INFINITY }))
          .sort((a, b) => b.value - a.value)
          .slice(0, operation.n);
        const labels = ranked.map(({ row }) => row.slice(0, valueIndex).map((c) => String(c ?? "")).join(" · "));
        const values = ranked.map(({ value }) => (value === Number.NEGATIVE_INFINITY ? 0 : value));
        return {
          operation: "top_n",
          summary: `top ${ranked.length} of ${operation.groupBy.join(", ")} by ${metric}(${operation.column})`,
          result: table(grouped.result.columns, ranked.map(({ row }) => row), { ...limits, maxRows: operation.n }),
          chart: { kind: "bar", labels, series: [{ name: `${metric}(${operation.column})`, values }], yLabel: operation.column },
        };
      }
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
      const rows = sheet.rows.filter((row) => match(row[index] as CellValue));
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
        const columnType = sheet.columns[index]!.type;
        const values = numericValues(sheet, operation.column);
        if (columnType === "number" && values.length === 0) {
          return { operation: "profile", summary: `No usable data in column "${operation.column}" (all values non-numeric or empty)` };
        }
        if (values.length > 0 && (columnType === "number" || values.length >= sheet.rows.length / 2)) {
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
        const counts = new Map<string, number>();
        for (const row of sheet.rows) {
          const key = String(row[index] ?? "(empty)");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        return {
          operation: "profile",
          summary: `${operation.column}: ${counts.size} unique value${counts.size === 1 ? "" : "s"} in ${sheet.rows.length} rows`,
          result: table(
            [
              { name: operation.column, type: "string" },
              { name: "count", type: "number" },
            ],
            top.map(([value, count]) => [value, count]),
            limits,
          ),
          chart: {
            kind: "bar",
            labels: top.map(([value]) => value),
            series: [{ name: "count", values: top.map(([, count]) => count) }],
            yLabel: "count",
          },
        };
      }
      const overview = sheet.columns.map((column) => {
        const cells = sheet.rows.map((row) => row[sheet.columns.indexOf(column)]);
        const nonNull = cells.filter((c) => c !== null && c !== undefined && c !== "");
        const unique = new Set(nonNull.map((c) => JSON.stringify(c))).size;
        const counts = new Map<string, number>();
        for (const cell of nonNull) {
          const key = String(cell);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        return [
          column.name,
          column.type,
          sheet.rows.length - nonNull.length,
          unique,
          top ? `${top[0]} (${top[1]})` : "",
        ] as CellValue[];
      });
      return {
        operation: "profile",
        summary: `profile of ${sheet.columns.length} columns (n=${sheet.rows.length})`,
        result: table(
          [
            { name: "column", type: "string" },
            { name: "type", type: "string" },
            { name: "nulls", type: "number" },
            { name: "unique", type: "number" },
            { name: "top value", type: "string" },
          ],
          overview,
          limits,
        ),
      };
    }
    case "outliers": {
      const values = numericValues(sheet, operation.column);
      if (values.length < 4) {
        return { operation: "outliers", summary: `Not enough numeric data in "${operation.column}" to detect outliers` };
      }
      const method = operation.method ?? "iqr";
      const index = columnIndex(sheet, operation.column);
      const flagged = new Set<number>();
      if (method === "zscore") {
        const threshold = operation.threshold ?? 3;
        const avg = seriesMean(values);
        const stdDev = sampleStdDev(values, avg);
        if (!(stdDev > 0)) {
          return { operation: "outliers", summary: `No spread in "${operation.column}" (stddev is 0)` };
        }
        sheet.rows.forEach((row, i) => {
          const v = row[index];
          if (typeof v === "number" && Math.abs((v - avg) / stdDev) > threshold) flagged.add(i);
        });
        const rows = [...flagged].map((i) => sheet.rows[i]!);
        return {
          operation: "outliers",
          summary: `${rows.length} outlier${rows.length === 1 ? "" : "s"} in "${operation.column}" (z-score > ${threshold})`,
          result: table(sheet.columns, rows, limits),
        };
      }
      const sorted = [...values].sort((a, b) => a - b);
      const q1 = quantileSorted(sorted, 0.25);
      const q3 = quantileSorted(sorted, 0.75);
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      sheet.rows.forEach((row, i) => {
        const v = row[index];
        if (typeof v === "number" && (v < lower || v > upper)) flagged.add(i);
      });
      const rows = [...flagged].map((i) => sheet.rows[i]!);
      return {
        operation: "outliers",
        summary: `${rows.length} outlier${rows.length === 1 ? "" : "s"} in "${operation.column}" (IQR fence [${lower.toFixed(2)}, ${upper.toFixed(2)}])`,
        result: table(sheet.columns, rows, limits),
      };
    }
    case "crosstab": {
      const xi = columnIndex(sheet, operation.x);
      const metric = operation.metric ?? "count";
      const yi = columnIndex(sheet, operation.y);
      const vi = operation.valueColumn ? columnIndex(sheet, operation.valueColumn) : -1;
      if (metric !== "count" && vi < 0) {
        throw new Error(`crosstab with metric "${metric}" needs valueColumn. Available columns: ${sheet.columns.map((c) => `"${c.name}"`).join(", ")}.`);
      }
      const xValues: string[] = [];
      const yValues: string[] = [];
      const seenX = new Set<string>();
      const seenY = new Set<string>();
      for (const row of sheet.rows) {
        const xv = String(row[xi] ?? "(empty)");
        const yv = String(row[yi] ?? "(empty)");
        if (!seenX.has(xv)) {
          seenX.add(xv);
          xValues.push(xv);
        }
        if (!seenY.has(yv)) {
          seenY.add(yv);
          yValues.push(yv);
        }
      }
      if (xValues.length > 30 || yValues.length > 30) {
        throw new Error(`crosstab too large (${xValues.length} × ${yValues.length}). Filter to fewer categories first.`);
      }
      const cells = new Map<string, number[]>();
      for (const row of sheet.rows) {
        const key = `${String(row[xi] ?? "(empty)")}\u0001${String(row[yi] ?? "(empty)")}`;
        const bucket = cells.get(key) ?? [];
        if (metric !== "count") {
          const v = vi >= 0 ? row[vi] : null;
          if (typeof v === "number") bucket.push(v);
        } else {
          bucket.push(1);
        }
        cells.set(key, bucket);
      }
      const cellValue = (xv: string, yv: string): CellValue => {
        const bucket = cells.get(`${xv}\u0001${yv}`) ?? [];
        if (metric === "count") return bucket.length;
        if (bucket.length === 0) return null;
        if (metric === "sum") return bucket.reduce((a, b) => a + b, 0);
        return bucket.reduce((a, b) => a + b, 0) / bucket.length;
      };
      return {
        operation: "crosstab",
        summary: `crosstab ${operation.x} × ${operation.y} (${metric}${metric === "count" ? "" : ` of ${operation.valueColumn}`})`,
        result: table(
          [{ name: `${operation.x} \\ ${operation.y}`, type: "string" }, ...yValues.map((y) => ({ name: y, type: "number" as const }))],
          xValues.map((xv) => [xv, ...yValues.map((yv) => cellValue(xv, yv))]),
          limits,
        ),
      };
    }
  }
}
