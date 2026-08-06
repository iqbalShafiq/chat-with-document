import type { AnyTool } from "@anvia/core";
import { createTool } from "@anvia/core";
import z from "zod";
import type { ToolResultContent } from "@anvia/core";
import { normalizePageImages } from "../document/types.js";

export interface FindDocumentsPrisma {
  document: {
    findMany(args: {
      where: {
        userId: string;
        status: "ready";
        id?: { in: string[] };
        sessionLinks?: { some: { sessionId: string; userId: string } };
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
      where: {
        id: string;
        userId: string;
        sessionLinks: { some: { sessionId: string; userId: string } };
      };
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

export interface SessionDocumentIdsPrisma {
  documentSession: {
    findMany(args: {
      where: {
        sessionId: string;
        userId: string;
        document: {
          status: "ready";
          userId: string;
          projectId?: string | null;
        };
      };
      select: { documentId: true };
    }): Promise<Array<{ documentId: string }>>;
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
    /** Optional origin session (audit only). Retrieval is document-scoped. */
    sessionId?: string;
    query: string;
    documentIds: string[];
    limit: number;
  }): Promise<ChunkSearchHit[]>;
}

export interface DocumentToolsDeps {
  userId: string;
  sessionId: string;
  /** When set, only project corpus docs may be resolved (defense in depth). */
  projectId?: string | null;
  prisma: FindDocumentsPrisma &
    NextPagePrisma &
    SessionDocumentIdsPrisma &
    PageImagesPrisma;
  searchService: ChunkSearchService;
  fetchPageImage: FetchPageImage;
}

export function createFindDocumentsTool(deps: {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: FindDocumentsPrisma & SessionDocumentIdsPrisma;
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
      const sessionDocIds = await resolveSessionDocumentIds(
        deps.prisma,
        deps.userId,
        deps.sessionId,
        deps.projectId,
      );
      if (sessionDocIds.length === 0) {
        return { results: [] };
      }

      const documents = await deps.prisma.document.findMany({
        where: {
          userId: deps.userId,
          status: "ready",
          id: { in: sessionDocIds },
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

async function resolveSessionDocumentIds(
  prisma: SessionDocumentIdsPrisma,
  userId: string,
  sessionId: string,
  projectId?: string | null,
): Promise<string[]> {
  const links = await prisma.documentSession.findMany({
    where: {
      sessionId,
      userId,
      document: {
        status: "ready",
        userId,
        // Standalone: projectId null; project: exact match. Matches app isolation.
        ...(projectId === undefined
          ? {}
          : projectId
            ? { projectId }
            : { projectId: null }),
      },
    },
    select: { documentId: true },
  });
  return links.map((link) => link.documentId);
}

export function createSearchDocumentPagesTool(deps: {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: SessionDocumentIdsPrisma;
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
      const sessionDocIds = await resolveSessionDocumentIds(
        deps.prisma,
        deps.userId,
        deps.sessionId,
        deps.projectId,
      );
      if (sessionDocIds.length === 0) {
        return { results: [] };
      }

      const allowed = new Set(sessionDocIds);
      const scopedIds =
        documentIds && documentIds.length > 0
          ? documentIds.filter((id) => allowed.has(id))
          : sessionDocIds;

      if (scopedIds.length === 0) {
        return { results: [] };
      }

      const hits = await deps.searchService.search({
        userId: deps.userId,
        sessionId: deps.sessionId,
        query,
        documentIds: scopedIds,
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
  projectId?: string | null;
  prisma: NextPagePrisma & SessionDocumentIdsPrisma;
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
      const sessionDocIds = await resolveSessionDocumentIds(
        deps.prisma,
        deps.userId,
        deps.sessionId,
        deps.projectId,
      );
      if (!sessionDocIds.includes(documentId)) {
        return { found: false, reason: "Document not found in current session" };
      }

      const document = await deps.prisma.document.findFirst({
        where: {
          id: documentId,
          userId: deps.userId,
          sessionLinks: {
            some: { sessionId: deps.sessionId, userId: deps.userId },
          },
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
    createGetDocumentPageImagesTool(deps),
  ];
}

export interface PageImagesPrisma {
  documentPage: {
    findFirst(args: {
      where: { documentId: string; pageIndex: number };
      select: { id: true; images: true };
    }): Promise<{ id: string; images: unknown } | null>;
  };
}

export interface FetchPageImage {
  (r2Key: string): Promise<Uint8Array>;
}

export function createGetDocumentPageImagesTool(deps: {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: PageImagesPrisma & SessionDocumentIdsPrisma;
  fetchPageImage: FetchPageImage;
  maxImages?: number;
}) {
  return createTool({
    name: "get_document_page_images",
    description:
      "Fetch images extracted from a document page (charts, photos, diagrams). Use when the answer depends on visual content in the document. Returns the images together with markdown references you can embed inline in your answer at the most relevant position.",
    input: z.object({
      documentId: z.string().min(1).describe("Document id from the session catalog"),
      pageIndex: z.number().int().min(0).describe("0-based page index"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(5)
        .describe("Max images to return"),
    }),
    execute: async ({ documentId, pageIndex, limit }) => {
      const sessionDocIds = await resolveSessionDocumentIds(
        deps.prisma,
        deps.userId,
        deps.sessionId,
        deps.projectId,
      );
      if (!sessionDocIds.includes(documentId)) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              found: false,
              reason: "Document not found in current session",
            }),
          },
        ] satisfies ToolResultContent[];
      }

      const page = await deps.prisma.documentPage.findFirst({
        where: { documentId, pageIndex },
        select: { id: true, images: true },
      });
      const images = normalizePageImages(page?.images).slice(0, limit);

      if (images.length === 0) {
        return [
          {
            type: "text",
            text: JSON.stringify({ found: true, pageIndex, imageCount: 0 }),
          },
        ] satisfies ToolResultContent[];
      }

      const content: ToolResultContent[] = [
        {
          type: "text",
          text: JSON.stringify({
            found: true,
            pageIndex,
            images: images.map((image) => ({
              id: image.id,
              mediaType: image.mediaType,
              markdown: `![${image.id}](/api/documents/${documentId}/pages/${pageIndex}/images/${image.id})`,
              ...(image.annotation === null || image.annotation === undefined
                ? {}
                : { annotation: image.annotation }),
            })),
          }),
        },
      ];

      const toFetch = images.slice(0, deps.maxImages ?? 5);
      const results = await Promise.allSettled(
        toFetch.map(async (image) => ({
          image,
          data: await deps.fetchPageImage(image.r2Key),
        })),
      );
      for (const result of results) {
        if (result.status === "rejected") continue;
        content.push({
          type: "image",
          data: Buffer.from(result.value.data).toString("base64"),
          mediaType: result.value.image.mediaType,
        });
      }

      return content;
    },
  });
}
