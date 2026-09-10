import { createTool, type AnyTool } from "@anvia/core";
import { z } from "zod";
import { runAnalysis, type AnalysisOperation } from "./tabular-analysis.js";
import { resolveSheetReady, type DatasetResolver } from "./tools.js";
import type { DatasetRef } from "./types.js";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "../static-definition.js";

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upload"), documentId: z.string().min(1), sheet: z.string().optional() }),
  z.object({ type: z.literal("document_table"), documentId: z.string().min(1), pageIndex: z.number().int().min(0), tableIndex: z.number().int().min(0) }),
]) as z.ZodType<DatasetRef>;

const chartRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bar"),
    x: z.string().min(1).describe("Group-by column for the x axis"),
    series: z.array(z.object({
      column: z.string().min(1),
      fn: z.enum(["sum", "mean", "count", "min", "max", "median"]),
    })).min(1).max(8).describe("One metric per legend series"),
    title: z.string().max(120).optional(),
    limit: z.number().int().min(2).max(30).optional().describe("Max groups shown (default 12)"),
  }),
  z.object({
    kind: z.literal("line"),
    x: z.string().min(1).describe("Ordered column for the x axis (number or ISO date)"),
    series: z.array(z.object({
      column: z.string().min(1),
      fn: z.enum(["sum", "mean", "count", "min", "max", "median"]),
    })).min(1).max(8).describe("One metric per legend series"),
    title: z.string().max(120).optional(),
    limit: z.number().int().min(2).max(100).optional().describe("Max points shown (default 50)"),
  }),
  z.object({
    kind: z.literal("scatter"),
    x: z.string().min(1).describe("Numeric x column"),
    y: z.string().min(1).describe("Numeric y column"),
    title: z.string().max(120).optional(),
    limit: z.number().int().min(10).max(500).optional().describe("Max points shown (default 200)"),
  }),
  z.object({
    kind: z.literal("histogram"),
    column: z.string().min(1).describe("Numeric column to bin"),
    title: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal("pie"),
    x: z.string().min(1).describe("Category column for slices"),
    column: z.string().min(1).describe("Numeric column summed per slice"),
    title: z.string().max(120).optional(),
    limit: z.number().int().min(2).max(12).optional().describe("Max slices shown (default 8, rest grouped as Other)"),
  }),
]);

const createChartInput = z.object({
  source: sourceSchema.describe("Which dataset to chart"),
  chart: chartRequestSchema.describe("What to draw; computation happens server-side"),
});

const createChartSpec = {
  name: "create_chart",
  description:
    "Draw a chart from a dataset when analyze_dataset does not cover the shape you need: multi-series bar/line, scatter, histogram, or pie. Computation is deterministic and server-side; you only choose kind, columns, and title. The only chart entrypoint — never describe chart numbers from memory. Returns the chart spec the UI renders plus the underlying table.",
  inputSchema: createChartInput,
} as const;

export const CHART_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(createChartSpec),
];

export function createChartTools(deps: {
  resolver: DatasetResolver;
  limits?: { maxRows?: number };
}): AnyTool[] {
  const createChart = createTool({
    ...createChartSpec,
    outputSchema: z.json(),
    execute: async ({ source, chart }) => {
      const sheet = await resolveSheetReady(deps.resolver, source);
      const limits = deps.limits?.maxRows === undefined ? undefined : { maxRows: deps.limits.maxRows };
      switch (chart.kind) {
        case "bar":
        case "line": {
          const operation: AnalysisOperation = {
            op: "aggregate",
            groupBy: [chart.x],
            metrics: chart.series,
          };
          const analysis = runAnalysis(sheet, operation, limits);
          if (!analysis.result) {
            throw new Error("Could not build the chart from this dataset. Check the columns and retry.");
          }
          const limit = chart.limit ?? (chart.kind === "bar" ? 12 : 50);
          const groupCount = 1;
          const labels = analysis.result.rows.slice(0, limit).map((row) => String(row[0] ?? ""));
          const series = chart.series.map((metric, i) => ({
            name: `${metric.fn}(${metric.column})`,
            values: analysis.result!.rows.slice(0, limit).map((row) => {
              const v = row[groupCount + i];
              return typeof v === "number" ? v : 0;
            }),
          }));
          const yLabel = chart.series.length === 1 ? chart.series[0]!.column : undefined;
          return {
            operation: "chart",
            summary: `${chart.kind} chart of ${chart.series.map((s) => `${s.fn}(${s.column})`).join(", ")} by ${chart.x}`,
            result: {
              ...analysis.result,
              rows: analysis.result.rows.slice(0, limit),
            },
            chart: {
              kind: chart.kind,
              labels,
              series,
              ...(yLabel ? { yLabel } : {}),
              ...(chart.title ? { title: chart.title } : {}),
            },
          };
        }
        case "scatter": {
          const analysis = runAnalysis(sheet, { op: "correlation", x: chart.x, y: chart.y }, limits);
          if (!analysis.chart || analysis.chart.kind !== "scatter") {
            throw new Error("Could not build the chart from this dataset. Check the columns and retry.");
          }
          const limit = chart.limit ?? 200;
          return {
            operation: "chart",
            summary: `scatter chart of ${chart.y} vs ${chart.x}`,
            chart: {
              kind: "scatter" as const,
              points: analysis.chart.points.slice(0, limit),
              xLabel: chart.x,
              yLabel: chart.y,
              ...(chart.title ? { title: chart.title } : {}),
            },
          };
        }
        case "histogram": {
          const analysis = runAnalysis(sheet, { op: "profile", column: chart.column }, limits);
          if (!analysis.chart || analysis.chart.kind !== "histogram") {
            throw new Error(`No usable numeric data in column "${chart.column}".`);
          }
          return {
            operation: "chart",
            summary: `histogram of ${chart.column}`,
            chart: {
              kind: "histogram" as const,
              bins: analysis.chart.bins,
              label: chart.column,
              ...(chart.title ? { title: chart.title } : {}),
            },
          };
        }
        case "pie": {
          const operation: AnalysisOperation = {
            op: "aggregate",
            groupBy: [chart.x],
            metrics: [{ column: chart.column, fn: "sum" }],
          };
          const analysis = runAnalysis(sheet, operation, limits);
          if (!analysis.result) {
            throw new Error("Could not build the chart from this dataset. Check the columns and retry.");
          }
          const limit = chart.limit ?? 8;
          const labels = analysis.result.rows.map((row) => String(row[0] ?? ""));
          const values = analysis.result.rows.map((row) => (typeof row[1] === "number" ? row[1] : 0));
          const pairs = labels.map((label, i) => ({ label, value: values[i] ?? 0 }))
            .sort((a, b) => b.value - a.value);
          const kept = pairs.slice(0, limit);
          if (pairs.length > limit) {
            const rest = pairs.slice(limit).reduce((sum, p) => sum + p.value, 0);
            kept.push({ label: "Other", value: rest });
          }
          return {
            operation: "chart",
            summary: `pie chart of sum(${chart.column}) by ${chart.x}`,
            result: analysis.result,
            chart: {
              kind: "pie" as const,
              labels: kept.map((p) => p.label),
              values: kept.map((p) => p.value),
              name: `sum(${chart.column})`,
              ...(chart.title ? { title: chart.title } : {}),
            },
          };
        }
      }
    },
  });

  return [createChart];
}
