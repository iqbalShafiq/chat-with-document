import { createTool, type AnyTool } from "@anvia/core";
import { z } from "zod";
import { runAnalysis, type AnalysisOperation } from "./tabular-analysis.js";
import type { SqlRunner } from "./sql.js";
import type { DatasetRef, TabularColumn, TabularSheet } from "./types.js";
import type { DerivedDocumentWriter } from "./derived-tools.js";
import { sheetFromRows, toCsvText } from "./parse-csv.js";
import {
  MAX_DERIVED_COLUMNS,
  MAX_DERIVED_HARD_COLUMNS,
  MAX_DERIVED_NAME_CHARS,
  MAX_DERIVED_ROWS,
} from "./limits.js";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "../static-definition.js";

export type UploadProvenance = {
  origin: string;
  parentDocumentId: string | null;
  originUrl: string | null;
};

export interface DatasetResolver {
  listUploads(): Promise<
    Array<{
      documentId: string;
      filename: string;
      sheets: Array<{ name: string; columns: Array<{ name: string; type: string }>; rowCount: number }>;
      provenance?: UploadProvenance;
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
        fn: z.enum(["sum", "mean", "count", "min", "max", "median", "count_distinct", "stddev"]),
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
  z.object({ op: z.literal("top_n"), column: z.string(), n: z.number().int(), groupBy: z.array(z.string()).optional(), metric: z.enum(["sum", "mean", "count", "min", "max", "median"]).optional() }),
  z.object({ op: z.literal("correlation"), x: z.string(), y: z.string() }),
  z.object({ op: z.literal("trend"), x: z.string(), y: z.string() }),
  z.object({ op: z.literal("stats"), column: z.string() }),
  z.object({ op: z.literal("regression"), x: z.string(), y: z.string(), predictFor: z.array(z.number().finite()).optional() }),
  z.object({ op: z.literal("outliers"), column: z.string(), method: z.enum(["iqr", "zscore"]).optional(), threshold: z.number().finite().optional() }),
  z.object({ op: z.literal("crosstab"), x: z.string(), y: z.string(), metric: z.enum(["count", "sum", "mean"]).optional(), valueColumn: z.string().optional() }),
]) as z.ZodType<AnalysisOperation>;
const jsonOutputSchema = z.json();

const saveAsSchema = z.object({
  name: z.string().trim().min(1).max(MAX_DERIVED_NAME_CHARS)
    .describe("Base filename for the saved result CSV (without prefix)"),
}).describe("Save this result as a new derived document instead of only returning it");

const readDatasetInput = z.object({
  source: sourceSchema.describe("Which dataset to inspect"),
});
const analyzeDatasetInput = z.object({
  source: sourceSchema,
  operation: operationSchema,
  saveAs: saveAsSchema.optional(),
});
const queryDatasetSqlInput = z.object({
  source: sourceSchema,
  query: z.string().min(1).describe("Read-only SQL SELECT query"),
  saveAs: saveAsSchema.optional(),
});

const readDatasetSpec = {
  name: "read_dataset",
  description:
    "Inspect a tabular dataset (CSV/XLSX upload, an agent-created [derived]/[synthetic] document, a [downloaded] URL document, or a table extracted from a document): returns the sheet name, row count, column names+types, and a preview of the first rows. Call this first to understand the data before analyzing, and to verify a create_dataset/fetch_dataset_from_url result is ready.",
  inputSchema: readDatasetInput,
} as const;
const analyzeDatasetSpec = {
  name: "analyze_dataset",
  description:
    "Run a deterministic data-analysis operation on a dataset (uploads, derived/synthetic/URL documents, or extracted tables): profile (per-column or categorical), aggregate (multi-metric), filter, sort, top_n (optionally grouped), correlation, trend (numeric or ISO dates), stats, regression, outliers (IQR/z-score), or crosstab. The only analysis entrypoint: never analyze pasted numbers directly — put them in a dataset first. Pass saveAs {name} to persist the result table as a new derived document for further chaining. Returns structured results and a chart spec the UI renders.",
  inputSchema: analyzeDatasetInput,
} as const;
const queryDatasetSqlSpec = {
  name: "query_dataset_sql",
  description:
    "Run a read-only SQL SELECT query over a dataset using sql.js (SQLite WASM). The table is named after the sheet (or use t). Only SELECT / WITH ... SELECT is allowed. Results are capped. Use for ad-hoc questions; prefer analyze_dataset for charts. Pass saveAs {name} to persist the result as a new derived document for further chaining.",
  inputSchema: queryDatasetSqlInput,
} as const;
const extractDocumentTablesSpec = {
  name: "extract_document_tables",
  description:
    "Discover GFM markdown tables inside the linked ready documents (e.g. tables OCR'd from PDFs). Returns each table's location (documentId, pageIndex, tableIndex), columns and row count so you can feed it back as a source to read_dataset / analyze_dataset / query_dataset_sql.",
  inputSchema: z.object({}),
} as const;

export const TABULAR_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(readDatasetSpec),
  createStaticToolDefinition(analyzeDatasetSpec),
  createStaticToolDefinition(queryDatasetSqlSpec),
  createStaticToolDefinition(extractDocumentTablesSpec),
];

export type TabularToolDeps = {
  resolver: DatasetResolver;
  sqlRunner: SqlRunner;
  limits?: { maxRows?: number };
  derived?: { writer: DerivedDocumentWriter };
};

function validateSaveAsName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error("saveAs.name must be non-empty.");
  return clean;
}

function sheetFromAnalysisResult(name: string, result: { columns: TabularColumn[]; rows: (string | number | boolean | null)[][] }): TabularSheet {
  if (result.columns.length === 0) throw new Error("Result has no columns to save.");
  if (result.columns.length > MAX_DERIVED_COLUMNS) {
    throw new Error(`Result has ${result.columns.length} columns (max ${MAX_DERIVED_COLUMNS}). Narrow the query first.`);
  }
  if (result.rows.length === 0) throw new Error("Result has no rows to save.");
  if (result.rows.length > MAX_DERIVED_ROWS) {
    throw new Error(`Result has ${result.rows.length} rows (max ${MAX_DERIVED_ROWS}). Narrow the query first.`);
  }
  return { name, columns: result.columns, rows: result.rows };
}

function inferCellType(values: (string | number | boolean | null)[]): TabularColumn["type"] {
  let sawBoolean = false;
  for (const value of values) {
    if (value === null) continue;
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") {
      sawBoolean = true;
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") continue;
      if (!Number.isFinite(Number(trimmed))) return "string";
      continue;
    }
    return "string";
  }
  return sawBoolean ? "boolean" : "string";
}

function sheetFromSqlResult(
  name: string,
  source: TabularSheet,
  result: { columns: string[]; rows: (string | number | null)[][] },
): TabularSheet {
  if (result.columns.length === 0) throw new Error("Result has no columns to save.");
  if (result.columns.length > MAX_DERIVED_COLUMNS) {
    throw new Error(`Result has ${result.columns.length} columns (max ${MAX_DERIVED_COLUMNS}). Narrow the query first.`);
  }
  if (result.rows.length === 0) throw new Error("Result has no rows to save.");
  if (result.rows.length > MAX_DERIVED_ROWS) {
    throw new Error(`Result has ${result.rows.length} rows (max ${MAX_DERIVED_ROWS}). Narrow the query first.`);
  }
  const sourceTypes = new Map(source.columns.map((c) => [c.name.toLowerCase(), c.type] as const));
  const columns: TabularColumn[] = result.columns.map((col, i) => {
    const fromSource = sourceTypes.get(col.toLowerCase());
    if (fromSource) return { name: col, type: fromSource };
    const columnValues = result.rows.map((row) => (row[i] ?? null) as string | number | boolean | null);
    return { name: col || `col${i + 1}`, type: inferCellType(columnValues) };
  });
  return { name, columns, rows: result.rows as TabularSheet["rows"] };
}

async function saveResultSheet(
  derived: { writer: DerivedDocumentWriter } | undefined,
  sheet: TabularSheet,
  saveAs: { name: string },
  parentDocumentId: string | null,
): Promise<{ documentId: string; filename: string; origin: "created"; status: string }> {
  if (!derived) {
    throw new Error("Saving results is not available in this session. Return the result without saveAs.");
  }
  const name = validateSaveAsName(saveAs.name);
  const csv = toCsvText({ ...sheet, name });
  const created = await derived.writer.createDerived({
    filename: `${name}.csv`,
    mimeType: "text/csv",
    data: new TextEncoder().encode(csv),
    origin: "created",
    parentDocumentId,
    sourceNote: parentDocumentId ? `saved ${sheet.name} result derived from ${parentDocumentId}` : `saved ${sheet.name} result`,
  });
  return { documentId: created.documentId, filename: created.filename, origin: "created", status: created.status };
}

function parentOf(ref: DatasetRef): string {
  return ref.documentId;
}

export function createTabularAnalysisTools(deps: TabularToolDeps): AnyTool[] {
  const { resolver, sqlRunner, limits } = deps;
  const resolvedLimits = limits?.maxRows === undefined ? undefined : { maxRows: limits.maxRows };

  const readDataset = createTool({
    ...readDatasetSpec,
    outputSchema: jsonOutputSchema,
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
    ...analyzeDatasetSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ source, operation, saveAs }) => {
      const sheet = await resolver.resolveSheet(source);
      const analysis = runAnalysis(sheet, operation, resolvedLimits);
      if (!saveAs) return jsonOutputSchema.parse(analysis);
      if (!analysis.result) {
        throw new Error("This operation returns no table to save. Use an operation with a result (aggregate, filter, sort, top_n) or save a SQL query instead.");
      }
      const saved = await saveResultSheet(
        deps.derived,
        sheetFromAnalysisResult(saveAs.name, analysis.result),
        saveAs,
        parentOf(source),
      );
      return jsonOutputSchema.parse({ ...analysis, saved });
    },
  });

  const queryDatasetSql = createTool({
    ...queryDatasetSqlSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ source, query, saveAs }) => {
      const sheet = await resolver.resolveSheet(source);
      const sqlResult = await sqlRunner(sheet, query, limits);
      if (!saveAs) return sqlResult;
      const saved = await saveResultSheet(
        deps.derived,
        sheetFromSqlResult(saveAs.name, sheet, sqlResult),
        saveAs,
        parentOf(source),
      );
      return { ...sqlResult, saved };
    },
  });

  const extractDocumentTables = createTool({
    ...extractDocumentTablesSpec,
    outputSchema: jsonOutputSchema,
    execute: async () => {
      return { tables: await resolver.listDocumentTables() };
    },
  });

  return [readDataset, analyzeDataset, queryDatasetSql, extractDocumentTables];
}
