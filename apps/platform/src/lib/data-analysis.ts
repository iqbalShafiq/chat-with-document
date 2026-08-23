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