import { createRequire } from "node:module";
import type { TabularSheet } from "./types.js";

const STATEMENT_RE = /^\s*(with\s+\w|select)\b/i;

export function assertReadOnlySql(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Query is empty");
  if (trimmed.includes(";")) throw new Error("Only a single statement is allowed");
  if (!STATEMENT_RE.test(trimmed)) {
    throw new Error("Only SELECT / WITH ... SELECT queries are allowed");
  }
}

export type SqlResult = {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  truncated: boolean;
};

export type SqlRunner = (
  sheet: TabularSheet,
  query: string,
  opts?: { maxRows?: number; timeoutMs?: number },
) => Promise<SqlResult>;

export function createSqlJsRunner(): SqlRunner {
  return async (sheet, query, opts = {}) => {
    const { maxRows = 500 } = opts;
    assertReadOnlySql(query);
    const { default: initSqlJs } = await import("sql.js");
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    });
    const db = new SQL.Database();
    try {
      const tableName = quoteIdent(sheet.name);
      const create = `CREATE TABLE ${tableName} (${sheet.columns
        .map((c) => `${quoteIdent(c.name)} ${c.type === "number" ? "REAL" : c.type === "boolean" ? "BOOLEAN" : "TEXT"}`)
        .join(", ")})`;
      db.exec(create);
      const insert = `INSERT INTO ${tableName} VALUES (${sheet.columns.map(() => "?").join(", ")})`;
      const stmt = db.prepare(insert);
      for (const row of sheet.rows) {
        stmt.bind(row as (string | number | null)[]);
        stmt.step();
        stmt.reset();
      }
      stmt.free();
      const wrapped = `SELECT * FROM (${query.replace(/;\s*$/, "")}) AS q LIMIT ${maxRows}`;
      const results = db.exec(wrapped);
      const first = results[0];
      const columns = first?.columns ?? sheet.columns.map((c) => c.name);
      const values = first?.values ?? [];
      return {
        columns,
        rows: values.map((row) => row.map(normalizeCell)),
        rowCount: values.length,
        truncated: values.length >= maxRows,
      };
    } finally {
      db.close();
    }
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return String(value);
}