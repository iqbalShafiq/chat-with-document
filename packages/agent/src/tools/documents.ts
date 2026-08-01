import type { AnyTool } from "@anvia/core";
import { createTool } from "@anvia/core";
import z from "zod";

export interface FindDocumentsPrisma {
  document: {
    findMany(args: {
      where: {
        userId: string;
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

export interface NextPagePrisma {
  document: {
    findFirst(args: {
      where: { id: string; userId: string; sessionId: string };
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

export interface ChunkSearchHit {
  chunkId: string;
  documentId: string;
  filename: string;
  pageId: string;
  pageIndex: number;
  chunkIndex: number;
  chunkText: string;
  score: number;
  hasNextPage: boolean;
}

export interface ChunkSearchService {
  search(args: {
    userId: string;
    sessionId: string;
    query: string;
    documentIds?: string[];
    limit: number;
  }): Promise<ChunkSearchHit[]>;
}

export interface DocumentToolsDeps {
  userId: string;
  sessionId: string;
  prisma: FindDocumentsPrisma & NextPagePrisma;
  searchService: ChunkSearchService;
}

export function createFindDocumentsTool(deps: {
  userId: string;
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
          userId: deps.userId,
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

export function createSearchDocumentPagesTool(deps: {
  userId: string;
  sessionId: string;
  searchService: ChunkSearchService;
}) {
  return createTool({
    name: "search_document_pages",
    description:
      "Semantic search over document page chunks in the current session. Returns top matching chunks grouped by relevance.",
    input: z.object({
      query: z.string().min(1).describe("Semantic search query"),
      documentIds: z
        .array(z.string())
        .optional()
        .describe("Optional document ids to narrow search"),
      limit: z.number().int().min(1).max(10).optional().default(5),
    }),
    execute: async ({ query, documentIds, limit }) => {
      const hits = await deps.searchService.search({
        userId: deps.userId,
        sessionId: deps.sessionId,
        query,
        ...(documentIds !== undefined ? { documentIds } : {}),
        limit,
      });

      const byPage = new Map<string, ChunkSearchHit[]>();
      for (const hit of hits) {
        const key = `${hit.documentId}:${hit.pageIndex}`;
        const group = byPage.get(key) ?? [];
        group.push(hit);
        byPage.set(key, group);
      }

      return {
        results: [...byPage.values()].map((group) => {
          const top = group[0]!;
          return {
            documentId: top.documentId,
            filename: top.filename,
            pageIndex: top.pageIndex,
            pageId: top.pageId,
            score: top.score,
            hasNextPage: top.hasNextPage,
            matchedChunks: group.map((item) => ({
              chunkId: item.chunkId,
              chunkIndex: item.chunkIndex,
              chunkText: item.chunkText,
              score: item.score,
            })),
          };
        }),
      };
    },
  });
}

export function createGetDocumentNextPageTool(deps: {
  userId: string;
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
        where: {
          id: documentId,
          userId: deps.userId,
          sessionId: deps.sessionId,
        },
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

export function createDocumentTools(deps: DocumentToolsDeps): AnyTool[] {
  return [
    createFindDocumentsTool(deps),
    createSearchDocumentPagesTool(deps),
    createGetDocumentNextPageTool(deps),
  ];
}
