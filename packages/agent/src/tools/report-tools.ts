import { z } from "zod";
import { createTool, type AnyTool } from "@anvia/core";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

/**
 * Rendered chart shapes (outputs of create_chart/analyze_dataset), NOT the
 * dataset-query request shape. The renderer draws these directly.
 */
const renderedChartSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bar"),
    labels: z.array(z.string()).max(100),
    series: z
      .array(z.object({ name: z.string(), values: z.array(z.number().finite()).max(500) }))
      .min(1)
      .max(8),
    title: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal("line"),
    labels: z.array(z.string()).max(100),
    series: z
      .array(z.object({ name: z.string(), values: z.array(z.number().finite()).max(500) }))
      .min(1)
      .max(8),
    title: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal("scatter"),
    points: z
      .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
      .max(500),
    xLabel: z.string().max(80).optional(),
    yLabel: z.string().max(80).optional(),
    title: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal("histogram"),
    bins: z.array(z.number().finite()).max(200),
    label: z.string().max(80).optional(),
    title: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal("pie"),
    labels: z.array(z.string()).max(30),
    values: z.array(z.number().finite()).max(30),
    name: z.string().max(80).optional(),
    title: z.string().max(120).optional(),
  }),
]);

const createPdfReportSpec = {
  name: "create_pdf_report",
  description:
    "Build a PDF report from markdown plus chart/image asset ids and a citation map. Saves as a derived report document in scope.",
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    markdown: z.string().min(1).max(100_000),
    assetIds: z.array(z.string()).max(10).optional(),
    citationMap: z
      .array(
        z.object({
          claim: z.string().min(1).max(500),
          documentId: z.string().optional(),
          pageIndex: z.number().int().min(0).optional(),
          webBundleId: z.string().optional(),
          url: z.string().max(2000).optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
} as const;

const snapshotChartSpec = {
  name: "snapshot_chart",
  description:
    "Freeze a rendered chart (the chart object from create_chart or analyze_dataset output) into a reusable captioned image asset for PDFs and sites. Pass the chart object itself, not the dataset query.",
  inputSchema: z.object({
    caption: z.string().min(1).max(280),
    chart: renderedChartSchema,
  }),
} as const;

const freezeWebBundleSpec = {
  name: "freeze_web_bundle",
  description: "Freeze web_search/fetch sources into a web bundle artifact for citations.",
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).min(1).max(50),
  }),
} as const;

const editPdfReportSpec = {
  name: "edit_pdf_report",
  description:
    "Revise an existing PDF report in place (same document, re-rendered). Never creates a duplicate for edits.",
  inputSchema: z.object({
    documentId: z.string().min(1).max(120),
    title: z.string().min(1).max(120).optional(),
    markdown: z.string().min(1).max(100_000).optional(),
  }),
} as const;

export const REPORT_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(createPdfReportSpec),
  createStaticToolDefinition(editPdfReportSpec),
  createStaticToolDefinition(snapshotChartSpec),
  createStaticToolDefinition(freezeWebBundleSpec),
];

export function createReportTools(deps: {
  createReport(input: {
    title: string;
    markdown: string;
    assetIds?: string[];
    citationMap?: Array<Record<string, unknown>>;
  }): Promise<{ documentId: string; filename: string }>;
  editReport(input: {
    documentId: string;
    title?: string;
    markdown?: string;
  }): Promise<{ documentId: string; filename: string }>;
  snapshotChart(input: { caption: string; chart: unknown }): Promise<{ imageId: string }>;
  freezeBundle(input: {
    title: string;
    sources: Array<{ url: string; title?: string }>;
  }): Promise<{ id: string }>;
  onFocus?: (input: { artifactId: string; artifactType: "document" | "image"; label?: string }) => void;
}): AnyTool[] {
  const jsonOutputSchema = z.json();
  type JsonOutput = z.output<typeof jsonOutputSchema>;
  const createPdfReport = createTool({
    ...createPdfReportSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ title, markdown, assetIds, citationMap }): Promise<JsonOutput> => {
      const result = await deps.createReport({
        title,
        markdown,
        ...(assetIds ? { assetIds } : {}),
        ...(citationMap ? { citationMap: citationMap as Array<Record<string, unknown>> } : {}),
      });
      deps.onFocus?.({ artifactId: result.documentId, artifactType: "document", label: title });
      return jsonOutputSchema.parse({ ...result });
    },
  });
  const snapshotChart = createTool({
    ...snapshotChartSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ caption, chart }): Promise<JsonOutput> => {
      const result = await deps.snapshotChart({ caption, chart });
      deps.onFocus?.({ artifactId: result.imageId, artifactType: "image", label: caption });
      return jsonOutputSchema.parse({ ...result });
    },
  });
  const freezeWebBundle = createTool({
    ...freezeWebBundleSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ title, sources }): Promise<JsonOutput> => {
      const result = await deps.freezeBundle({
        title,
        sources: sources.map((s) => (s.title ? { url: s.url, title: s.title } : { url: s.url })),
      });
      return jsonOutputSchema.parse({ ...result });
    },
  });
  const editPdfReport = createTool({
    ...editPdfReportSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ documentId, title, markdown }): Promise<JsonOutput> => {
      const result = await deps.editReport({
        documentId,
        ...(title ? { title } : {}),
        ...(markdown ? { markdown } : {}),
      });
      deps.onFocus?.({
        artifactId: result.documentId,
        artifactType: "document",
        ...(title ? { label: title } : {}),
      });
      return jsonOutputSchema.parse({ ...result });
    },
  });
  return [createPdfReport, editPdfReport, snapshotChart, freezeWebBundle];
}
