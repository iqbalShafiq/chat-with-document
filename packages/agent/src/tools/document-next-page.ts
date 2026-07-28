import { createTool } from "@anvia/core";
import z from "zod";

export interface NextPagePrisma {
  document: {
    findFirst(args: {
      where: { id: string; sessionId: string };
      select: { id: true; pageCount: true; filename: true };
    }): Promise<{ id: string; pageCount: number; filename: string } | null>;
  };
  documentPage: {
    findFirst(args: {
      where: { documentId: string; pageIndex: number };
      select: {
        id: true;
        pageIndex: true;
        summary: true;
        rawMarkdown: true;
      };
    }): Promise<{
      id: string;
      pageIndex: number;
      summary: string;
      rawMarkdown: string;
    } | null>;
  };
}

export function createGetDocumentNextPageTool(deps: {
  sessionId: string;
  prisma: NextPagePrisma;
}) {
  return createTool({
    name: "get_document_next_page",
    description:
      "Fetch the next page of a document as raw markdown. Use when vector search results seem incomplete and you need sequential continuation.",
    input: z.object({
      documentId: z.string().min(1),
      pageIndex: z.number().int().min(0),
    }),
    execute: async ({ documentId, pageIndex }) => {
      const document = await deps.prisma.document.findFirst({
        where: { id: documentId, sessionId: deps.sessionId },
        select: { id: true, pageCount: true, filename: true },
      });

      if (!document) {
        return { found: false, reason: "Document not found in current session" };
      }

      const nextIndex = pageIndex + 1;
      if (nextIndex >= document.pageCount) {
        return {
          found: false,
          documentId: document.id,
          filename: document.filename,
          reason: "No next page",
        };
      }

      const page = await deps.prisma.documentPage.findFirst({
        where: { documentId: document.id, pageIndex: nextIndex },
        select: {
          id: true,
          pageIndex: true,
          summary: true,
          rawMarkdown: true,
        },
      });

      if (!page) {
        return {
          found: false,
          documentId: document.id,
          filename: document.filename,
          reason: "Next page not indexed yet",
        };
      }

      return {
        found: true,
        documentId: document.id,
        filename: document.filename,
        pageId: page.id,
        pageIndex: page.pageIndex,
        summary: page.summary,
        rawMarkdown: page.rawMarkdown,
        hasNextPage: nextIndex + 1 < document.pageCount,
      };
    },
  });
}
