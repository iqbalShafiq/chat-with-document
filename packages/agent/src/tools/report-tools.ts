import { z } from "zod";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

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
    "Freeze a create_chart/analyze_dataset chart spec into a reusable image asset (captioned) for PDFs and sites.",
  inputSchema: z.object({
    caption: z.string().min(1).max(280),
    chart: z.json(),
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

export const REPORT_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(createPdfReportSpec),
  createStaticToolDefinition(snapshotChartSpec),
  createStaticToolDefinition(freezeWebBundleSpec),
];
