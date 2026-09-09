import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { ChartSpec } from "#/lib/data-analysis";

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  SVGRenderer,
]);

const CHART_HEIGHT = 260;
const FALLBACK_WIDTH = 320;
const ZOOM_THRESHOLD = 50;

const PALETTE = [
  "#e8a317",
  "#6ee7a8",
  "#7dd3fc",
  "#f0abfc",
  "#fca5a5",
  "#c4b5fd",
  "#fde68a",
  "#86efac",
];
const AXIS_COLOR = "#9a948c";
const SPLIT_COLOR = "rgba(255,255,255,0.08)";

export function chartAriaLabel(spec: ChartSpec): string {
  switch (spec.kind) {
    case "bar":
    case "line":
      return `${spec.kind} chart${spec.title ? `: ${spec.title}` : ""}, ${spec.series.length} ${spec.series.length === 1 ? "series" : "series"}, ${spec.labels.length} categories`;
    case "scatter":
      return `scatter chart${spec.title ? `: ${spec.title}` : ""}, ${spec.points.length} points`;
    case "histogram":
      return `histogram${spec.title ? `: ${spec.title}` : ""}, ${spec.bins.length} bins`;
    case "pie":
      return `pie chart${spec.title ? `: ${spec.title}` : ""}, ${spec.labels.length} slices`;
  }
}

function hashSpec(spec: ChartSpec): string {
  return JSON.stringify(spec);
}

export function buildChartOption(spec: ChartSpec): EChartsCoreOption {
  const baseText = { color: AXIS_COLOR, fontFamily: "inherit", fontSize: 11 };
  const tooltip = {
    trigger: spec.kind === "scatter" || spec.kind === "pie" ? ("item" as const) : ("axis" as const),
    backgroundColor: "#141414",
    borderColor: "rgba(255,255,255,0.12)",
    textStyle: { color: "#f2efe9", fontSize: 12 },
  };
  const title = spec.title ? { text: spec.title, left: "center", textStyle: { ...baseText, fontSize: 12, fontWeight: 600 } } : undefined;

  switch (spec.kind) {
    case "bar":
    case "line": {
      const multi = spec.series.length > 1;
      return {
        color: PALETTE,
        title,
        tooltip: { ...tooltip, axisPointer: { type: "shadow" } },
        legend: multi ? { type: "scroll", bottom: 0, textStyle: baseText, icon: "roundRect", itemGap: 16, padding: [8, 0, 0, 0] } : undefined,
        grid: { left: 8, right: 12, top: spec.title ? 36 : 16, bottom: multi ? 32 : 12, containLabel: true },
        xAxis: {
          type: "category",
          data: spec.labels,
          axisLabel: { ...baseText, hideOverlap: true },
          axisLine: { lineStyle: { color: SPLIT_COLOR } },
          axisTick: { show: false },
        },
        yAxis: {
          type: "value",
          name: spec.yLabel,
          nameTextStyle: baseText,
          axisLabel: baseText,
          splitLine: { lineStyle: { color: SPLIT_COLOR } },
        },
        series: spec.series.map((s) => ({
          name: s.name,
          type: spec.kind,
          data: s.values,
          ...(spec.kind === "line" ? { showSymbol: s.values.length <= ZOOM_THRESHOLD, smooth: false } : { barMaxWidth: 48 }),
        })),
        ...(spec.kind === "line" && spec.labels.length > ZOOM_THRESHOLD
          ? { dataZoom: [{ type: "inside", xAxisIndex: 0 }] }
          : {}),
      };
    }
    case "scatter": {
      const zoom = spec.points.length > ZOOM_THRESHOLD ? [{ type: "inside", xAxisIndex: 0, yAxisIndex: 0 }] : undefined;
      return {
        color: PALETTE,
        title,
        tooltip,
        grid: { left: 8, right: 12, top: spec.title ? 36 : 16, bottom: 12, containLabel: true },
        xAxis: {
          type: "value",
          name: spec.xLabel,
          nameTextStyle: baseText,
          axisLabel: baseText,
          splitLine: { lineStyle: { color: SPLIT_COLOR } },
        },
        yAxis: {
          type: "value",
          name: spec.yLabel,
          nameTextStyle: baseText,
          axisLabel: baseText,
          splitLine: { lineStyle: { color: SPLIT_COLOR } },
        },
        series: [
          {
            type: "scatter",
            symbolSize: 7,
            data: spec.points.map((p) => [p.x, p.y]),
          },
        ],
        ...(zoom ? { dataZoom: zoom } : {}),
      };
    }
    case "histogram": {
      return {
        color: PALETTE,
        title,
        tooltip: { ...tooltip, axisPointer: { type: "shadow" } },
        grid: { left: 8, right: 12, top: spec.title ? 36 : 16, bottom: 12, containLabel: true },
        xAxis: {
          type: "category",
          data: spec.bins.map((b) => `${trimNumber(b.min)}–${trimNumber(b.max)}`),
          axisLabel: { ...baseText, hideOverlap: true },
          axisLine: { lineStyle: { color: SPLIT_COLOR } },
          axisTick: { show: false },
        },
        yAxis: {
          type: "value",
          name: spec.label,
          nameTextStyle: baseText,
          axisLabel: baseText,
          splitLine: { lineStyle: { color: SPLIT_COLOR } },
        },
        series: [{ type: "bar", data: spec.bins.map((b) => b.count), barMaxWidth: 48 }],
      };
    }
    case "pie": {
      return {
        color: PALETTE,
        title,
        tooltip,
        legend: { type: "scroll", bottom: 0, textStyle: baseText, icon: "circle", itemGap: 16, padding: [8, 0, 0, 0] },
        series: [
          {
            type: "pie",
            name: spec.name,
            radius: ["42%", "68%"],
            center: ["50%", "46%"],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: "#0c0c0c", borderWidth: 2 },
            label: { ...baseText, formatter: "{b}\n{d}%" },
            data: spec.labels.map((label, i) => ({ name: label, value: spec.values[i] ?? 0 })),
          },
        ],
      };
    }
  }
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function DataChart({ spec }: { spec: ChartSpec }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const option = useMemo(() => buildChartOption(spec), [hashSpec(spec)]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const chart = echarts.init(container, null, {
      renderer: "svg",
      width: container.clientWidth || FALLBACK_WIDTH,
      height: CHART_HEIGHT,
    });
    chart.setOption({ ...option, animation: reduceMotion ? false : undefined }, { notMerge: true });
    const onResize = () => chart.resize();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onResize);
      observer.observe(container);
    } else {
      window.addEventListener("resize", onResize);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [option]);

  return (
    <div role="img" aria-label={chartAriaLabel(spec)} className="w-full overflow-hidden rounded-lg border border-white/[0.06] p-2">
      <div ref={containerRef} style={{ width: "100%", height: CHART_HEIGHT }} />
    </div>
  );
}