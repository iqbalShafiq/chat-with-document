import { createTool } from "@anvia/core";
import z from "zod";

export interface FindDocumentsPrisma {
  document: {
    findMany(args: {
      where: {
        sessionId: string;
        status: "ready";
        OR: Array<{
          filename?: { contains: string; mode: "insensitive" };
          summary?: { contains: string; mode: "insensitive" };
          firstPageSummary?: { contains: string; mode: "insensitive" };
        }>;
      };
      take: number;
      orderBy: { createdAt: "desc" };
      select: {
        id: true;
        filename: true;
        firstPageSummary: true;
        summary: true;
        pageCount: true;
      };
    }): Promise<
      Array<{
        id: string;
        filename: string;
        firstPageSummary: string;
        summary: string;
        pageCount: number;
      }>
    >;
  };
}

export function createFindDocumentsTool(deps: {
  sessionId: string;
  prisma: FindDocumentsPrisma;
}) {
  return createTool({
    name: "find_documents",
    description:
      "Search documents in the current chat session by filename or summary text. Use when the relevant document id is not clear from the session catalog.",
    input: z.object({
      query: z.string().min(1).describe("Search query for document discovery"),
      limit: z.number().int().min(1).max(20).optional().default(5),
    }),
    execute: async ({ query, limit }) => {
      const documents = await deps.prisma.document.findMany({
        where: {
          sessionId: deps.sessionId,
          status: "ready",
          OR: [
            { filename: { contains: query, mode: "insensitive" } },
            { summary: { contains: query, mode: "insensitive" } },
            { firstPageSummary: { contains: query, mode: "insensitive" } },
          ],
        },
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          filename: true,
          firstPageSummary: true,
          summary: true,
          pageCount: true,
        },
      });

      return {
        results: documents.map((doc) => ({
          documentId: doc.id,
          filename: doc.filename,
          pageCount: doc.pageCount,
          firstPageSummary: doc.firstPageSummary,
        })),
      };
    },
  });
}
