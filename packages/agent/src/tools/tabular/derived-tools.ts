import { createTool, type AnyTool } from "@anvia/core";
import { z } from "zod";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "../static-definition.js";
import {
  DERIVED_PREVIEW_ROWS,
  FETCH_TIMEOUT_MS,
  MAX_DERIVED_CELL_CHARS,
  MAX_DERIVED_COLUMNS,
  MAX_DERIVED_HARD_COLUMNS,
  MAX_DERIVED_NAME_CHARS,
  MAX_DERIVED_ROWS,
  MAX_FETCH_BYTES,
  MAX_SOURCE_NOTE_CHARS,
} from "./limits.js";
import { fetchTabularUrl } from "./fetch-csv.js";
import { sheetFromRows, toCsvText } from "./parse-csv.js";
import type { CellValue } from "./types.js";

export type DerivedDocumentOrigin = "created" | "fetched";

export type DerivedDocumentResult = {
  documentId: string;
  filename: string;
  origin: "created" | "fetched";
  status: string;
};

export interface DerivedDocumentWriter {
  createDerived(input: {
    filename: string;
    mimeType: string;
    data: Uint8Array;
    origin: "created" | "fetched";
    parentDocumentId?: string | null;
    originUrl?: string | null;
    sourceNote?: string | null;
    synthetic?: boolean;
  }): Promise<DerivedDocumentResult>;
  countDerived(): Promise<number>;
}

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const createDatasetInput = z.object({
  name: z.string().trim().min(1).max(MAX_DERIVED_NAME_CHARS)
    .describe("Base filename for the new CSV (without prefix; the server adds [derived]/[synthetic])"),
  columns: z.array(z.string()).min(1).max(MAX_DERIVED_HARD_COLUMNS)
    .describe("Column names; must be unique after trimming"),
  rows: z.array(z.array(cellSchema)).min(1).max(MAX_DERIVED_ROWS)
    .describe("Table rows; every row must have exactly columns.length cells"),
  derivedFrom: z.object({ documentId: z.string().min(1) }).optional()
    .describe("REQUIRED when deriving from an existing session/project CSV: the source document id"),
  sourceNote: z.string().trim().max(MAX_SOURCE_NOTE_CHARS).optional()
    .describe("REQUIRED when the values come from the web: source URL + access date for citations"),
});

const fetchDatasetInput = z.object({
  url: z.string().url().describe("Absolute http(s) URL to a public CSV/XLSX file"),
  name: z.string().trim().min(1).max(MAX_DERIVED_NAME_CHARS).optional()
    .describe("Optional base filename; defaults to the URL path name"),
  reason: z.string().trim().min(1).max(MAX_SOURCE_NOTE_CHARS)
    .describe("Why this download is needed and what question it will answer. Shown when approval is required."),
});

const createDatasetSpec = {
  name: "create_dataset",
  description:
    "Create a new CSV document from values you already hold: a synthetic example the user asked for, numbers copied from web_search/web_fetch results, a table the user pasted in chat, or a derivation (filter/summary/transform) of an existing session/project CSV you read via read_dataset. Do NOT use it when an existing dataset already answers the question — analyze that directly. Do NOT invent factual data and present it as real. Output is a queued document: call read_dataset on the returned documentId to verify it is ready before analyze_dataset.",
  inputSchema: createDatasetInput,
} as const;

const fetchDatasetSpec = {
  name: "fetch_dataset_from_url",
  description:
    "Download a public CSV/XLSX file from an http(s) URL into the session library (e.g. a link from web_search, data.gov, GitHub raw, or a published Google Sheet CSV). Prefer this over copying thousands of rows by hand into create_dataset. Only direct file links work; for HTML pages use web_fetch and then create_dataset. Output is a queued document: call read_dataset on the returned documentId to verify it is ready before analyze_dataset.",
  inputSchema: fetchDatasetInput,
} as const;

export const DERIVED_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(createDatasetSpec),
  createStaticToolDefinition(fetchDatasetSpec),
];

function toText(cell: CellValue): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  return String(cell);
}

function validateCreateInput(input: z.infer<typeof createDatasetInput>): { columns: string[]; rawRows: string[][] } {
  const columns = input.columns.map((c) => c.trim());
  if (columns.some((c) => c === "")) {
    throw new Error("Column names must be non-empty. Rename blank columns (e.g. col3) and retry.");
  }
  const seen = new Set<string>();
  for (const column of columns) {
    const key = column.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate column "${column}". Rename or merge duplicates and retry.`);
    seen.add(key);
  }
  if (columns.length > MAX_DERIVED_COLUMNS) {
    throw new Error(`Too many columns (${columns.length} > ${MAX_DERIVED_COLUMNS}). Narrow the table or upload a file instead.`);
  }
  const rawRows: string[][] = [];
  input.rows.forEach((row, index) => {
    if (row.length !== columns.length) {
      throw new Error(`Row ${index + 1} has ${row.length} cells but ${columns.length} columns. Fix the row and retry.`);
    }
    const texts = row.map(toText);
    for (const text of texts) {
      if (text.length > MAX_DERIVED_CELL_CHARS) {
        throw new Error(`Row ${index + 1} has a cell over ${MAX_DERIVED_CELL_CHARS} chars. Shorten or split it and retry.`);
      }
    }
    rawRows.push(texts);
  });
  return { columns, rawRows };
}

const FETCHABLE_MEDIA_TYPES = new Set([
  "text/csv",
  "text/plain",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const clean = last.split("?")[0]!.split("#")[0]!;
    return clean || fallback;
  } catch {
    return fallback;
  }
}

export function createDerivedDatasetTools(deps: {
  writer: DerivedDocumentWriter;
  fetchFn?: typeof fetch | undefined;
  webFetchGate?: {
    enabled: boolean;
    hasGrant?: (toolName: "web_search" | "web_fetch") => Promise<boolean> | boolean;
  };
}): AnyTool[] {
  const createDataset = createTool({
    ...createDatasetSpec,
    outputSchema: z.json(),
    execute: async ({ name, columns, rows, derivedFrom, sourceNote }) => {
      const { columns: cleanColumns, rawRows } = validateCreateInput({ name, columns, rows, derivedFrom, sourceNote });
      const sheet = sheetFromRows("dataset", [cleanColumns, ...rawRows]);
      const csv = toCsvText({ ...sheet, name });
      const created = await deps.writer.createDerived({
        filename: `${name}.csv`,
        mimeType: "text/csv",
        data: new TextEncoder().encode(csv),
        origin: "created",
        parentDocumentId: derivedFrom?.documentId ?? null,
        sourceNote: sourceNote?.trim() ? sourceNote.trim() : derivedFrom ? `derived from ${derivedFrom.documentId}` : "synthetic example",
        synthetic: !derivedFrom && !sourceNote?.trim(),
      });
      return {
        documentId: created.documentId,
        filename: created.filename,
        origin: "created",
        rowCount: sheet.rows.length,
        columns: sheet.columns,
        preview: sheet.rows.slice(0, DERIVED_PREVIEW_ROWS),
        status: created.status,
        next: "Call read_dataset with { type: 'upload', documentId } to verify readiness, then analyze_dataset.",
      };
    },
  });

  const fetchDataset = createTool({
    ...fetchDatasetSpec,
    outputSchema: z.json(),
    // Reuses the web-search approval gate (keputusan final #2): when the
    // session web toggle is on (or a grant exists), no approval is needed;
    // otherwise the run suspends with the caller's reason, like web_fetch.
    requiresApproval: async (args: { reason: string }, _context: unknown) => {
      const gate = deps.webFetchGate;
      if (!gate) return { reason: args.reason };
      if (gate.enabled) return false;
      try {
        if (await gate.hasGrant?.("web_fetch")) return false;
      } catch {
        return { reason: args.reason };
      }
      return { reason: args.reason };
    },
    execute: async ({ url, name, reason }) => {
      const fetched = await fetchTabularUrl(url, { fetchFn: deps.fetchFn, maxBytes: MAX_FETCH_BYTES, timeoutMs: FETCH_TIMEOUT_MS });
      const isXlsxMagic = fetched.bytes.length >= 2 && fetched.bytes[0] === 0x50 && fetched.bytes[1] === 0x4b;
      const mediaType = FETCHABLE_MEDIA_TYPES.has(fetched.mediaType)
        ? fetched.mediaType
        : isXlsxMagic
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : null;
      if (!mediaType) {
        throw new Error(`URL did not return a CSV/XLSX file (content-type: ${fetched.mediaType}). Use web_fetch to read the page, then create_dataset.`);
      }
      const base = (name?.trim() || filenameFromUrl(fetched.finalUrl, "dataset")).replace(/\.(csv|xlsx)$/i, "");
      const mimeType = mediaType.includes("sheet") || (isXlsxMagic && mediaType === "application/octet-stream")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv";
      const created = await deps.writer.createDerived({
        filename: `${base}.${mimeType === "text/csv" ? "csv" : "xlsx"}`,
        mimeType,
        data: fetched.bytes,
        origin: "fetched",
        originUrl: fetched.finalUrl,
        sourceNote: `${fetched.finalUrl} (content-type: ${fetched.mediaType}; reason: ${reason.trim()})`,
      });
      return {
        documentId: created.documentId,
        filename: created.filename,
        origin: "fetched",
        originUrl: fetched.finalUrl,
        status: created.status,
        next: "Call read_dataset with { type: 'upload', documentId } to verify readiness, then analyze_dataset.",
      };
    },
  });

  return [createDataset, fetchDataset];
}
