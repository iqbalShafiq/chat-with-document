import type { CellValue, ColumnType, TabularSheet } from "./types.js";

export function parseCsv(text: string): string[][] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function detectHeader(rows: string[][]): {
  header: string[];
  dataRows: string[][];
} {
  const header = rows[0] ?? [];
  return { header, dataRows: rows.slice(1) };
}

function toCell(value: string, type: ColumnType): CellValue {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (type === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") {
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
    return null;
  }
  return trimmed;
}

export function inferColumnTypes(rows: string[][]): ColumnType[] {
  const columnCount = Math.max(0, ...rows.map((r) => r.length));
  const types: ColumnType[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    let type: ColumnType = "number";
    for (const row of rows) {
      const raw = row[c]?.trim() ?? "";
      if (raw === "") continue;
      if (type === "number" && raw !== "" && !Number.isFinite(Number(raw))) {
        type = "string";
      }
      if (type === "string") break;
    }
    types.push(type);
  }
  return types;
}

export function coerceRow(row: string[], types: ColumnType[]): CellValue[] {
  return types.map((type, index) => toCell(row[index] ?? "", type));
}

export function sheetFromRows(name: string, rawRows: string[][]): TabularSheet {
  const { header, dataRows } = detectHeader(rawRows);
  const types = inferColumnTypes(dataRows);
  const columns = header.map((h, i) => ({ name: h.trim() || `col${i + 1}`, type: types[i] ?? "string" }));
  const rows = dataRows.map((row) => coerceRow(row, types));
  return { name, columns, rows };
}
