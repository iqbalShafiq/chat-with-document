import { createTool } from "@anvia/core";
import z from "zod";

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
    sessionId: string;
    query: string;
    documentIds?: string[];
    limit: number;
  }): Promise<ChunkSearchHit[]>;
}

export function createSearchDocumentPagesTool(deps: {
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
