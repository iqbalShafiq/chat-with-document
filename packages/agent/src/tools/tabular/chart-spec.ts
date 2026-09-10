export type ChartSpec =
  | {
      kind: "bar";
      labels: string[];
      series: { name: string; values: number[] }[];
      xLabel?: string;
      yLabel?: string;
      title?: string;
    }
  | {
      kind: "line";
      labels: string[];
      series: { name: string; values: number[] }[];
      xLabel?: string;
      yLabel?: string;
      title?: string;
    }
  | { kind: "scatter"; points: { x: number; y: number }[]; xLabel?: string; yLabel?: string; title?: string }
  | { kind: "histogram"; bins: { min: number; max: number; count: number }[]; label?: string; title?: string }
  | { kind: "pie"; labels: string[]; values: number[]; name?: string; title?: string };
