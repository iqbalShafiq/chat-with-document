import { describe, expect, it } from "vitest";
import { createTabularResolver } from "./tabular-resolver.js";

function prismaMock(overrides: Record<string, unknown>) {
  return overrides as never;
}

describe("tabular resolver", () => {
  it("uses frozen document ids without querying current session links", async () => {
    let linkedLookupCalls = 0;
    const prisma = prismaMock({
      document: {
        findMany: async () => [
          {
            id: "d-frozen",
            filename: "frozen.csv",
            tabularData: {
              sheets: [{ name: "sheet", columns: [], rows: [] }],
            },
          },
        ],
      },
      documentSession: {
        findMany: async () => {
          linkedLookupCalls += 1;
          return [];
        },
      },
    });
    const resolver = createTabularResolver({
      userId: "u1",
      sessionId: "s1",
      projectId: null,
      documentIds: ["d-frozen"],
      prisma,
    });

    await resolver.listUploads();

    expect(linkedLookupCalls).toBe(0);
  });

  it("rejects a sheet outside the frozen document scope", async () => {
    const documentLookup = async () => ({
      id: "d-other",
      filename: "other.csv",
      mimeType: "text/csv",
      tabularData: {
        sheets: [{ name: "sheet", columns: [], rows: [] }],
      },
    });
    const prisma = prismaMock({
      document: { findFirst: documentLookup },
      documentSession: { findMany: async () => [] },
    });
    const resolver = createTabularResolver({
      userId: "u1",
      sessionId: "s1",
      projectId: null,
      documentIds: ["d-frozen"],
      prisma,
    });

    await expect(
      resolver.resolveSheet({ type: "upload", documentId: "d-other" }),
    ).rejects.toThrow("Dataset not found or empty");
  });

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

  it("resolves a derived document created mid-run within the same scope", async () => {
    const prisma = prismaMock({
      document: {
        findMany: async () => [
          {
            id: "d-derived",
            filename: "[derived] ringkas.csv",
            tabularData: { sheets: [{ name: "ringkas", columns: [], rows: [] }] },
            origin: "created",
            parentDocumentId: "d1",
            originUrl: null,
          },
        ],
        findFirst: async () => ({
          id: "d-derived",
          tabularData: { sheets: [{ name: "ringkas", columns: [{ name: "region", type: "string" }], rows: [["east"]] }] },
        }),
      },
      documentSession: { findMany: async () => [{ documentId: "d-derived" }] },
    });
    const resolver = createTabularResolver({ userId: "u1", sessionId: "s1", projectId: null, prisma });
    const uploads = await resolver.listUploads();
    expect(uploads[0]).toMatchObject({
      documentId: "d-derived",
      provenance: { origin: "created", parentDocumentId: "d1", originUrl: null },
    });
    const sheet = await resolver.resolveSheet({ type: "upload", documentId: "d-derived" });
    expect(sheet.name).toBe("ringkas");
  });
});
