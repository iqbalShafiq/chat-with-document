import readXlsxFile from "read-excel-file/node";
import { sheetFromRows } from "./parse-csv.js";
import type { TabularSheet } from "./types.js";

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell);
}

export async function parseXlsx(
  buffer: Uint8Array,
  filename?: string,
): Promise<TabularSheet[]> {
  const workbook = await readXlsxFile(Buffer.from(buffer));
  const sheets: TabularSheet[] = [];
  for (let index = 0; index < workbook.length; index += 1) {
    const { sheet, data } = workbook[index]!;
    if (data.length === 0) continue;
    const rawRows = data.map((row) => row.map(cellToString));
    sheets.push(sheetFromRows(sheet || filename || `Sheet${index + 1}`, rawRows));
  }
  return sheets;
}