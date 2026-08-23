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
