import { createTool, type AnyTool } from "@anvia/core";
import { z } from "zod";
import { runAnalysis, type AnalysisOperation } from "./tabular-analysis.js";
import type { SqlRunner } from "./sql.js";
import type { DatasetRef, TabularSheet } from "./types.js";

export interface DatasetResolver {
  listUploads(): Promise<
    Array<{
      documentId: string;
      filename: string;
      sheets: Array<{ name: string; columns: Array<{ name: string; type: string }>; rowCount: number }>;
    }>
  >;
  resolveSheet(ref: { type: "upload"; documentId: string; sheet?: string } | { type: "document_table"; documentId: string; pageIndex: number; tableIndex: number }): Promise<TabularSheet>;
  listDocumentTables(): Promise<
    Array<{
      documentId: string;
      filename: string;
      pageIndex: number;
      tableIndex: number;
      columns: Array<{ name: string; type: string }>;
      rowCount: number;
    }>
  >;
}

// createTool eagerly converts the input schema to JSON schema; z.custom() throws there,
// so model the operation as a full discriminated union, typed as AnalysisOperation.
const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upload"), documentId: z.string().min(1), sheet: z.string().optional() }),
  z.object({ type: z.literal("document_table"), documentId: z.string().min(1), pageIndex: z.number().int().min(0), tableIndex: z.number().int().min(0) }),
]) as z.ZodType<DatasetRef>;
const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("profile"), column: z.string().optional() }),
  z.object({
    op: z.literal("aggregate"),
    groupBy: z.array(z.string()),
    metrics: z.array(
      z.object({
        column: z.string(),
        fn: z.enum(["sum", "mean", "count", "min", "max", "median"]),
      }),
    ),
  }),
  z.object({
    op: z.literal("filter"),
    column: z.string(),
    predicate: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
    value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  }),
  z.object({ op: z.literal("sort"), column: z.string(), order: z.enum(["asc", "desc"]) }),
  z.object({ op: z.literal("top_n"), column: z.string(), n: z.number().int() }),
  z.object({ op: z.literal("correlation"), x: z.string(), y: z.string() }),
  z.object({ op: z.literal("trend"), x: z.string(), y: z.string() }),
]) as z.ZodType<AnalysisOperation>;

export type TabularToolDeps = {
  resolver: DatasetResolver;
  sqlRunner: SqlRunner;
  limits?: { maxRows?: number };
};

export function createTabularAnalysisTools(deps: TabularToolDeps): AnyTool[] {
  const { resolver, sqlRunner, limits } = deps;
  const resolvedLimits = limits?.maxRows === undefined ? undefined : { maxRows: limits.maxRows };

  const readDataset = createTool({
    name: "read_dataset",
    description:
      "Inspect a tabular dataset (CSV/XLSX upload or a table extracted from a document): returns the sheet name, row count, column names+types, and a preview of the first rows. Call this first to understand the data before analyzing.",
    input: z.object({ source: sourceSchema.describe("Which dataset to inspect") }),
    execute: async ({ source }) => {
      const sheet = await resolver.resolveSheet(source);
      return {
        name: sheet.name,
        rowCount: sheet.rows.length,
        columns: sheet.columns,
        preview: sheet.rows.slice(0, 10),
      };
    },
  });

  const analyzeDataset = createTool({
    name: "analyze_dataset",
    description:
      "Run a deterministic data-analysis operation on a dataset: profile (per-column stats + histogram), aggregate (groupBy + sum/mean/count/min/max/median + bar chart), filter, sort, top_n, correlation between two numeric columns (scatter), or trend (line). Returns structured results and a chart spec the UI renders.",
    input: z.object({
      source: sourceSchema,
      operation: operationSchema,
    }),
    execute: async ({ source, operation }) => {
      const sheet = await resolver.resolveSheet(source);
      return runAnalysis(sheet, operation, resolvedLimits);
    },
  });

  const queryDatasetSql = createTool({
    name: "query_dataset_sql",
    description:
      "Run a read-only SQL SELECT query over a dataset using DuckDB. The table is named after the sheet (or use t). Only SELECT / WITH ... SELECT is allowed. Results are capped. Use for ad-hoc questions; prefer analyze_dataset for charts.",
    input: z.object({
      source: sourceSchema,
      query: z.string().min(1).describe("Read-only SQL SELECT query"),
    }),
    execute: async ({ source, query }) => {
      const sheet = await resolver.resolveSheet(source);
      return sqlRunner(sheet, query, limits);
    },
  });

  const extractDocumentTables = createTool({
    name: "extract_document_tables",
    description:
      "Discover GFM markdown tables inside the linked ready documents (e.g. tables OCR'd from PDFs). Returns each table's location (documentId, pageIndex, tableIndex), columns and row count so you can feed it back as a source to read_dataset / analyze_dataset / query_dataset_sql.",
    input: z.object({}),
    execute: async () => {
      return { tables: await resolver.listDocumentTables() };
    },
  });

  return [readDataset, analyzeDataset, queryDatasetSql, extractDocumentTables];
}