export type CellValue = number | string | boolean | null;
export type ColumnType = "number" | "string" | "boolean" | "null";
export type TabularColumn = { name: string; type: ColumnType };
export type TabularSheet = {
  name: string;
  columns: TabularColumn[];
  rows: CellValue[][];
};
export type DatasetRef =
  | { type: "upload"; documentId: string; sheet?: string }
  | {
      type: "document_table";
      documentId: string;
      pageIndex: number;
      tableIndex: number;
    };
