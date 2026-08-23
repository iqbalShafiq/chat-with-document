import { describe, expect, it } from "vitest";
import { createTabularResolver } from "./tabular-resolver.js";

function prismaMock(overrides: Record<string, unknown>) {
  return overrides as never;
}

describe("tabular resolver", () => {
  it("resolves an upload sheet from Document.tabularData", async () => {
    const prisma = prismaMock({
      document: {
        findFirst: async () => ({
          id: "d1",
          filename: "sales.csv",
          mimeType: "text/csv",
          tabularData: {
            sheets: [
              {
                name: "sales",
                columns: [{ name: "region", type: "string" }],
                rows: [["east"], ["west"]],
              },
            ],
          },
        }),
      },
      documentPage: { findFirst: async () => null },
      documentSession: { findMany: async () => [{ documentId: "d1" }] },
    });
    const resolver = createTabularResolver({
      userId: "u1",
      sessionId: "s1",
      projectId: null,
      prisma,
    });
    const sheet = await resolver.resolveSheet({ type: "upload", documentId: "d1" });
    expect(sheet.name).toBe("sales");
    expect(sheet.rows).toEqual([["east"], ["west"]]);
  });

  it("parses document tables from a page's rawMarkdown on demand", async () => {
    const prisma = prismaMock({
      document: { findFirst: async () => null },
      documentPage: {
        findFirst: async () => ({ rawMarkdown: "| a | b |\n| - | - |\n| 1 | 2 |\n" }),
      },
      documentSession: { findMany: async () => [{ documentId: "d1" }] },
    });
    const resolver = createTabularResolver({ userId: "u1", sessionId: "s1", projectId: null, prisma });
    const sheet = await resolver.resolveSheet({
      type: "document_table",
      documentId: "d1",
      pageIndex: 0,
      tableIndex: 0,
    });
    expect(sheet.columns[0]!.name).toBe("a");
    expect(sheet.rows[0]).toEqual([1, 2]);
  });
});