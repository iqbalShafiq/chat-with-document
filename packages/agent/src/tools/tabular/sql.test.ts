import { describe, expect, it } from "vitest";
import { assertReadOnlySql, createSqlJsRunner } from "./sql.js";
import type { TabularSheet } from "./types.js";

describe("assertReadOnlySql", () => {
  it("accepts SELECT and WITH ... SELECT", () => {
    expect(() => assertReadOnlySql("SELECT * FROM t")).not.toThrow();
    expect(() => assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).not.toThrow();
  });
  it("rejects DDL/DML and multiple statements", () => {
    expect(() => assertReadOnlySql("DELETE FROM t")).toThrow();
    expect(() => assertReadOnlySql("DROP TABLE t")).toThrow();
    expect(() => assertReadOnlySql("INSERT INTO t VALUES (1)")).toThrow();
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow();
  });
});

describe("createSqlJsRunner", () => {
  it("runs a SELECT over the sheet and caps rows", async () => {
    const sheet: TabularSheet = {
      name: "sales",
      columns: [
        { name: "region", type: "string" },
        { name: "revenue", type: "number" },
      ],
      rows: Array.from({ length: 20 }, (_, i) => [i % 2 === 0 ? "east" : "west", i]),
    };
    const runner = createSqlJsRunner();
    const result = await runner(sheet, "SELECT region, SUM(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC", { maxRows: 5 });
    expect(result.columns).toEqual(["region", "total"]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    await expect(
      runner(sheet, "DELETE FROM sales", {}),
    ).rejects.toThrow();
  });

  it("exposes the sheet under the stable alias t", async () => {
    const sheet: TabularSheet = {
      name: "my sheet",
      columns: [{ name: "revenue", type: "number" }],
      rows: [[10], [20]],
    };
    const runner = createSqlJsRunner();
    const result = await runner(sheet, "SELECT SUM(revenue) AS total FROM t", {});
    expect(result.rows).toEqual([[30]]);
  });

  it("aborts between insert batches when the signal fires", async () => {
    const sheet: TabularSheet = {
      name: "big",
      columns: [{ name: "n", type: "number" }],
      rows: Array.from({ length: 400 }, (_, i) => [i]),
    };
    const runner = createSqlJsRunner();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      runner(sheet, "SELECT COUNT(*) AS c FROM t", { abortSignal: controller.signal }),
    ).rejects.toThrow();
  });
});