export type ChartSpec =
  | { kind: "bar"; labels: string[]; series: { name: string; values: number[] }[]; xLabel?: string; yLabel?: string; title?: string }
  | { kind: "line"; labels: string[]; series: { name: string; values: number[] }[]; xLabel?: string; yLabel?: string; title?: string }
  | { kind: "scatter"; points: { x: number; y: number }[]; xLabel?: string; yLabel?: string; title?: string }
  | { kind: "histogram"; bins: { min: number; max: number; count: number }[]; label?: string; title?: string }
  | { kind: "pie"; labels: string[]; values: number[]; name?: string; title?: string };

export type TableDto = {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseChartSpec(value: unknown): ChartSpec | null {
  if (!isRecord(value)) return null;
  const title = optionalString(value.title);
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
      return {
        kind: value.kind,
        labels,
        series,
        ...(optionalString(value.xLabel) ? { xLabel: optionalString(value.xLabel) } : {}),
        ...(optionalString(value.yLabel) ? { yLabel: optionalString(value.yLabel) } : {}),
        ...(title ? { title } : {}),
      };
    }
    case "scatter": {
      const points = Array.isArray(value.points)
        ? value.points.filter((p): p is { x: number; y: number } => isRecord(p) && typeof p.x === "number" && typeof p.y === "number")
        : [];
      if (points.length === 0) return null;
      return {
        kind: "scatter",
        points,
        ...(optionalString(value.xLabel) ? { xLabel: optionalString(value.xLabel) } : {}),
        ...(optionalString(value.yLabel) ? { yLabel: optionalString(value.yLabel) } : {}),
        ...(title ? { title } : {}),
      };
    }
    case "histogram": {
      const bins = Array.isArray(value.bins)
        ? value.bins.filter((b): b is { min: number; max: number; count: number } => isRecord(b) && typeof b.min === "number" && typeof b.max === "number" && typeof b.count === "number")
        : [];
      if (bins.length === 0) return null;
      return {
        kind: "histogram",
        bins,
        ...(optionalString(value.label) ? { label: optionalString(value.label) } : {}),
        ...(title ? { title } : {}),
      };
    }
    case "pie": {
      const labels = Array.isArray(value.labels) ? value.labels.filter((l) => typeof l === "string") : [];
      const values = Array.isArray(value.values) ? value.values.filter((v): v is number => typeof v === "number") : [];
      if (labels.length === 0 || values.length === 0 || labels.length !== values.length) return null;
      return {
        kind: "pie",
        labels,
        values,
        ...(optionalString(value.name) ? { name: optionalString(value.name) } : {}),
        ...(title ? { title } : {}),
      };
    }
    default:
      return null;
  }
}

/** Pull chart objects out of Deep Research ```dataset-chart fences. */
export function extractDatasetChartBlocks(output: unknown): unknown[] {
  if (typeof output !== "string") return [];
  const charts: unknown[] = [];
  const pattern = /```dataset-chart\s*\n([\s\S]*?)```/g;
  for (const match of output.matchAll(pattern)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (isRecord(parsed) && parsed.chart !== undefined && parseChartSpec(parsed.chart)) {
        charts.push(parsed.chart);
      }
    } catch {
      // ignore malformed fences
    }
  }
  return charts;
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

export const CHART_EMBED_PATTERN = /!\[chart:(\d+)\]\(\)/g;

export function chartEmbedIndex(alt: string | null | undefined): number | null {
  if (!alt) return null;
  const match = /^chart:(\d+)$/.exec(alt.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}