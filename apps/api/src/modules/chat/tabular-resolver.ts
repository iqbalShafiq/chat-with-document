import type { DatasetResolver, TabularSheet } from "@assingment/agent";
import { extractMarkdownTables, sheetFromRows } from "@assingment/agent";
import { Prisma } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

type TabularData = { sheets: TabularSheet[] };

export type TabularResolverDeps = {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: PrismaClient;
};

export function createTabularResolver(deps: TabularResolverDeps): DatasetResolver {
  const { userId, sessionId, projectId, prisma } = deps;

  async function linkedDocumentIds(): Promise<string[]> {
    const rows = await prisma.documentSession.findMany({
      where: {
        sessionId,
        userId,
        document: { status: "ready", userId, ...(projectId ? { projectId } : {}) },
      },
      select: { documentId: true },
    });
    return rows.map((r) => r.documentId);
  }

  return {
    async listUploads() {
      const ids = await linkedDocumentIds();
      if (ids.length === 0) return [];
      const docs = await prisma.document.findMany({
        where: { id: { in: ids }, tabularData: { not: Prisma.DbNull } },
        select: { id: true, filename: true, tabularData: true },
      });
      return docs.map((doc) => {
        const sheets = ((doc.tabularData as TabularData | null)?.sheets ?? []).map((s) => ({
          name: s.name,
          columns: s.columns,
          rowCount: s.rows.length,
        }));
        return { documentId: doc.id, filename: doc.filename, sheets };
      });
    },

    async resolveSheet(ref) {
      if (ref.type === "upload") {
        const doc = await prisma.document.findFirst({
          where: { id: ref.documentId, userId, ...(projectId ? { projectId } : {}) },
          select: { tabularData: true },
        });
        const sheets = (doc?.tabularData as TabularData | null)?.sheets ?? [];
        if (ref.sheet) {
          const match = sheets.find((s) => s.name === ref.sheet);
          if (match) return match;
        }
        const first = sheets[0];
        if (!first) throw new Error("Dataset not found or empty");
        return first;
      }
      const page = await prisma.documentPage.findFirst({
        where: { document: { id: ref.documentId, userId, status: "ready" }, pageIndex: ref.pageIndex },
        select: { rawMarkdown: true },
      });
      const tables = page ? extractMarkdownTables(page.rawMarkdown) : [];
      const table = tables[ref.tableIndex];
      if (!table) throw new Error("Table not found");
      return sheetFromRows(`doc-table-${ref.tableIndex + 1}`, [
        table.columns,
        ...table.rows,
      ]);
    },

    async listDocumentTables() {
      const ids = await linkedDocumentIds();
      const out: Array<{
        documentId: string;
        filename: string;
        pageIndex: number;
        tableIndex: number;
        columns: Array<{ name: string; type: string }>;
        rowCount: number;
      }> = [];
      if (ids.length === 0) return out;
      const docs = await prisma.document.findMany({
        where: { id: { in: ids }, status: "ready" },
        select: { id: true, filename: true, pages: { select: { pageIndex: true, rawMarkdown: true }, orderBy: { pageIndex: "asc" } } },
      });
      for (const doc of docs) {
        for (const page of doc.pages) {
          const tables = extractMarkdownTables(page.rawMarkdown);
          tables.forEach((table, tableIndex) => {
            const sheet = sheetFromRows(`t${tableIndex}`, [table.columns, ...table.rows]);
            out.push({
              documentId: doc.id,
              filename: doc.filename,
              pageIndex: page.pageIndex,
              tableIndex,
              columns: sheet.columns,
              rowCount: sheet.rows.length,
            });
          });
        }
      }
      return out;
    },
  };
}